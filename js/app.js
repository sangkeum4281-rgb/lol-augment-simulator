// ============================================================================
// 무작위 총력전: 아수라장(증바람) - 증강 뽑기 시뮬레이터
// React (UMD) + Babel standalone 으로 빌드 없이 브라우저에서 바로 동작합니다.
// 데이터는 js/data.js 의 window.CHAMPIONS / window.AUGMENTS 를 사용합니다.
// ============================================================================

const { useState, useMemo, useCallback, useEffect, useRef } = React;

const LEVELS = [3, 7, 11, 15];
const TIER_ORDER = ["silver", "gold", "prism"];
// 실제 게임 규칙: 리롤은 카드 3장 전체가 아니라 "카드 한 장씩" 걸려있고, 한 장당 1번만 가능.
// 가끔 등장하는 황금 주사위로 리롤하면 같은 등급이 아니라 한 단계 위 등급으로 바뀜(실버→골드→프리즘).
const GOLDEN_REROLL_CHANCE = 0.05;

// ── 방문/뽑기 통계 (Supabase) ──────────────────────────────────────────────
// anon(공개) key라 브라우저에 그대로 노출돼도 괜찮음: DB 쪽에 RLS로
// "insert만 허용, select는 전면 차단" 정책이 걸려있어서 이 키로는 데이터를
// 못 읽고, 오직 pick_counts() 함수로 집계된 숫자만 가져올 수 있음.
const SUPABASE_URL = "https://taoqimkfqmxmwhvuafes.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRhb3FpbWtmcW14bXdodnVhZmVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5MTU3MTEsImV4cCI6MjEwNDQ5MTcxMX0.N0k7IOfZEG-0nz0sfwXKHJDBwu4afEapqSwGAT6wA9o";
const statsClient =
  window.supabase && window.supabase.createClient
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// 완성된 빌드 하나를 기록. 실패해도(네트워크 끊김, 광고 차단기 등) 게임 진행에는
// 영향 없도록 조용히 무시한다.
async function logPick(champion, picks) {
  if (!statsClient) return;
  try {
    await statsClient.from("picks").insert({
      champion_id: champion.id,
      champion_name: champion.name,
      augments: LEVELS.map((lv) => ({
        level: lv,
        id: picks[lv].id,
        name: picks[lv].name,
        tier: picks[lv].tier,
      })),
    });
  } catch (e) {
    console.warn("[stats] pick 기록 실패:", e);
  }
}

// 누적/오늘 뽑기 수 집계 조회. 실패 시 null 반환(화면에서는 숨김 처리).
async function fetchPickCounts() {
  if (!statsClient) return null;
  try {
    const { data, error } = await statsClient.rpc("pick_counts");
    if (error || !data || !data[0]) return null;
    return { total: Number(data[0].total), today: Number(data[0].today) };
  } catch (e) {
    console.warn("[stats] 카운트 조회 실패:", e);
    return null;
  }
}

function nextTier(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.min(idx + 1, TIER_ORDER.length - 1)];
}

// ---------------------------------------------------------------------------
// 유틸: 가중치 기반 무작위 뽑기
// ---------------------------------------------------------------------------
function weightedPickOne(items, weightFn) {
  const total = items.reduce((sum, it) => sum + Math.max(weightFn(it), 0), 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (const it of items) {
    r -= Math.max(weightFn(it), 0);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

// "퀘스트: OOO" 이름의 증강은 조건을 채울 시간이 필요해서, 3번째 라운드(11레벨)부터는
// 뽑기 풀에서 제외 — 1/2번째 라운드(3/7레벨)까지만 등장하도록 함.
function isQuestAugment(augment) {
  return augment.name.startsWith("퀘스트:");
}
function augmentPoolForLevel(level) {
  return level > LEVELS[1] ? window.AUGMENTS.filter((a) => !isQuestAugment(a)) : window.AUGMENTS;
}

// 특정 등급 안에서 하나만 뽑기 (카드 개별 리롤용). level을 넘기면 해당 레벨 기준으로
// 퀘스트 증강 제외 규칙까지 같이 적용됨(리롤/전환 등 모든 경로에서 규칙이 새지 않도록).
// champion을 넘기면 궁합 가중치(window.getAugmentFitWeight)만큼 확률이 살짝 기울어짐.
function pickOneOfTier(tier, excludeIds = [], level = null, champion = null) {
  const basePool = level != null ? augmentPoolForLevel(level) : window.AUGMENTS;
  const candidates = basePool.filter((a) => a.tier === tier && !excludeIds.includes(a.id));
  const pool = candidates.length > 0 ? candidates : basePool.filter((a) => a.tier === tier);
  if (champion) return weightedPickOne(pool, (a) => window.getAugmentFitWeight(a, champion));
  return pool[Math.floor(Math.random() * pool.length)];
}

// 리스트에서 서로 다른 n개를 무작위로 뽑기 (같은 카드가 중복으로 나오지 않도록)
function pickNUnique(list, n) {
  const pool = list.slice();
  const picked = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

// pickNUnique의 가중치 버전: 매번 뽑을 때마다 남은 후보들 중에서 weightFn 비중대로 하나를 골라
// 빼내는 걸 n번 반복 — 챔피언 궁합 좋은 증강이 "더 잘 뜨긴 하지만 여전히 무작위"이게 함
function pickNUniqueWeighted(list, n, weightFn) {
  const pool = list.slice();
  const picked = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const total = pool.reduce((sum, it) => sum + Math.max(weightFn(it), 0.0001), 0);
    let r = Math.random() * total;
    let idx = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      r -= Math.max(weightFn(pool[j]), 0.0001);
      if (r <= 0) { idx = j; break; }
    }
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

// 실제 게임 규칙: 한 번의 증강 선택 라운드에서는 "라운드 전체"가 하나의 등급으로 결정되고,
// 그 라운드에 뜨는 3장은 전부 같은 등급 안에서만 뽑힘 (골드가 뜨면 3장 다 골드).
// 예외는 오직 황금 리롤 하나뿐 — 그걸로 리롤한 카드 한 장만 한 단계 위 등급으로 바뀜.
// champion을 넘기면 그 챔피언과 궁합 좋은 증강이 살짝 더 잘 뜨도록 가중치가 걸림(약하게).
function makePool(level, excludeIds = [], champion = null) {
  const weights = window.LEVEL_TIER_WEIGHTS[level];
  const roundTier = weightedPickOne(TIER_ORDER, (tier) => weights[tier]);
  const basePool = augmentPoolForLevel(level);

  const candidates = basePool.filter((a) => a.tier === roundTier && !excludeIds.includes(a.id));
  const pool = candidates.length >= 3 ? candidates : basePool.filter((a) => a.tier === roundTier);
  const picked = champion
    ? pickNUniqueWeighted(pool, 3, (a) => window.getAugmentFitWeight(a, champion))
    : pickNUnique(pool, 3);

  return picked.map((augment, i) => ({
    slotId: `${level}-${i}`,
    augment,
    isGolden: augment.tier !== "prism" && Math.random() < GOLDEN_REROLL_CHANCE, // 프리즘은 더 오를 등급이 없음
    rerollUsed: false,
    version: 0, // 리롤될 때마다 +1 → React key가 바뀌어 팝인 애니메이션이 그 카드만 재생됨
  }));
}

// ---------------------------------------------------------------------------
// 챔피언 아이콘 (Data Dragon 이미지 실패 시 이니셜 원형으로 폴백)
// ---------------------------------------------------------------------------
function ChampionAvatar({ champion, size = "w-16 h-16", textSize = "text-xl" }) {
  const [failed, setFailed] = useState(false);
  if (!champion) return null;
  if (failed) {
    return (
      <div
        className={`${size} rounded-xl bg-gradient-to-br from-indigo-500 to-sky-400 flex items-center justify-center font-bold ${textSize} shrink-0`}
      >
        {champion.name.slice(0, 1)}
      </div>
    );
  }
  return (
    <img
      src={window.getChampionImageUrl(champion.id)}
      alt={champion.name}
      onError={() => setFailed(true)}
      className={`${size} rounded-xl object-cover shrink-0 bg-slate-800`}
    />
  );
}

// ---------------------------------------------------------------------------
// 화면 1: 챔피언 선택
// ---------------------------------------------------------------------------
function ChampionSelectScreen({ onConfirm }) {
  // 검색해서 직접 고르는 대신, 실제 아수라장처럼 "시작하기"를 누르면 173명 전체 로스터에서
  // 무작위 3명이 나오고 그중 하나를 고르는 방식
  const [candidates, setCandidates] = useState(null);
  const [pickCounts, setPickCounts] = useState(null); // { total, today } | null(로딩 전/실패 시 숨김)

  useEffect(() => {
    let cancelled = false;
    fetchPickCounts().then((counts) => {
      if (!cancelled) setPickCounts(counts);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rollChampions = () => {
    const pool = window.CHAMPIONS.slice();
    const picked = [];
    for (let i = 0; i < 3 && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    setCandidates(picked);
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-16 min-h-screen flex flex-col items-center justify-center text-center">
      <header className="mb-10 anim-in">
        <p className="text-sky-400 font-semibold tracking-widest text-sm mb-2">RANDOM ARAM · AUGMENT ROULETTE</p>
        <h1 className="font-title text-3xl md:text-4xl font-black">무작위 총력전: 아수라장 <span className="text-fuchsia-400">(증바람)</span></h1>
        <p className="text-slate-400 mt-3">
          {candidates
            ? "셋 중 하나를 골라보세요."
            : "버튼을 누르면 전체 챔피언 중 무작위 3명이 나와요. 그중 하나로 3/7/11/15레벨 증강 빌드를 완성해보세요."}
        </p>
      </header>

      {!candidates ? (
        <div className="flex flex-col items-center gap-4">
          <button
            onClick={rollChampions}
            className="anim-in px-10 py-5 rounded-2xl text-xl font-black bg-gradient-to-r from-sky-500 to-fuchsia-500 hover:brightness-110 text-white shadow-[0_0_30px_rgba(56,189,248,0.4)] transition-all"
          >
            🎲 아수라장 시작하기
          </button>
          {pickCounts && (
            <p className="anim-in text-sm text-slate-500">
              🔥 지금까지 <span className="text-slate-300 font-bold">{pickCounts.total.toLocaleString()}</span>명,
              오늘 <span className="text-slate-300 font-bold">{pickCounts.today.toLocaleString()}</span>명이 뽑았어요
            </p>
          )}
        </div>
      ) : (
        <div className="w-full anim-in">
          <div className="grid grid-cols-3 gap-4 sm:gap-6 mb-8">
            {candidates.map((c, i) => (
              <button
                key={c.id}
                onClick={() => onConfirm(c)}
                style={{ animationDelay: `${i * 90}ms` }}
                className="anim-in group flex flex-col items-center gap-3 p-5 rounded-2xl border border-slate-700 bg-slate-900/50 hover:border-sky-400 hover:bg-slate-800/70 hover:scale-[1.03] transition-all"
              >
                <ChampionAvatar champion={c} size="w-20 h-20 sm:w-24 sm:h-24" textSize="text-3xl" />
                <div>
                  <div className="font-bold text-lg">{c.name}</div>
                  <div className="text-xs text-slate-500">{c.role}</div>
                </div>
              </button>
            ))}
          </div>
          <button onClick={rollChampions} className="text-slate-400 hover:text-slate-200 text-sm underline underline-offset-4">
            🎲 다시 뽑기
          </button>
        </div>
      )}
    </div>
  );
}

// 리롤 버튼 아이콘 (실제 게임처럼 원형 새로고침 화살표)
function RefreshIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.6-5.9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M20 3.5v5.4h-5.4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// 증강 아이콘: CommunityDragon 공식 이미지가 있으면 그걸 쓰고, 없거나 로드 실패하면 이모지로 대체
function AugmentIcon({ augment, size = "w-9 h-9", emojiSize = "text-3xl" }) {
  // 데이터에 있는 모든 증강은 실제로 동작하는 아이콘만 남겨뒀으므로,
  // 프리로드 확인 없이 곧바로 렌더링 (새로고침/리롤 시 이모지가 잠깐 먼저 뜨는 깜빡임 방지)
  if (!augment.iconUrl) {
    return <span className={`relative z-10 ${emojiSize} drop-shadow`}>{augment.icon}</span>;
  }

  // 대부분 흰색 실루엣인 원본 아이콘을 마스크로 써서, 그 모양 그대로 등급별 그라데이션 색을 입힘
  // (밝기가 제각각인 아이콘도 항상 또렷한 등급 색이 나오도록 CSS filter 대신 mask 방식 사용)
  const meta = window.TIER_META[augment.tier];
  return (
    <div
      role="img"
      aria-label={augment.name}
      className={`relative z-10 ${size} bg-gradient-to-br ${meta.grad} drop-shadow-lg`}
      style={{
        WebkitMaskImage: `url("${augment.iconUrl}")`,
        maskImage: `url("${augment.iconUrl}")`,
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// 증강 카드
// 실제 게임의 "세로 카드 + 중앙 원형 글로우 배지" 연출을 참고한 디자인.
// 카드 3장이 뜰 때 순서대로 살짝 튕겨 나오듯(index만큼 delay) 등장하고, 뜬 직후 한 번 빛이 훑고 지나감.
// 카드마다 자기만의 리롤 버튼이 붙어있음 — 일반 버튼은 같은 등급 재추첨, 황금 버튼은 등급 업그레이드.
// ---------------------------------------------------------------------------
function AugmentCard({ slot, selected, onPick, onReroll, index = 0 }) {
  const { augment, isGolden, rerollUsed } = slot;
  const meta = window.TIER_META[augment.tier];

  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick();
    }
  };

  // CommunityDragon 원본 에셋(512x512)은 카드 모양 주위에 투명 여백이 있어서,
  // CommunityDragon 원본 에셋(512x512)은 실제 카드가 가로로 약 60.9%만 차지하고 나머지가
  // 투명 여백이라, 그 실측값(100/0.609 ≈ 164.2%)만큼 확대해야 카드 테두리가 컨테이너 경계에
  // 딱 맞음 — 이전 값(159%/103%)은 눈대중이라 살짝 작아서 선택 테두리가 카드보다 크게 붕 떠 보였음
  const cardArtStyle = { backgroundSize: "164.2% 100%", backgroundPosition: "center", backgroundRepeat: "no-repeat" };

  return (
    // 카드 + 리롤 버튼을 세로로 쌓되, 버튼은 카드와 겹치지 않게 아래쪽에 별도로 둠
    <div className="flex flex-col items-center gap-1.5 sm:gap-3">
      <div
        role="button"
        tabIndex={0}
        onClick={onPick}
        onKeyDown={handleKeyDown}
        style={{ animationDelay: `${index * 90}ms`, aspectRatio: "322 / 502" }}
        className={`augment-pop relative w-full max-w-[240px] mx-auto rounded-2xl cursor-pointer select-none transition-transform ${
          selected ? `ring-4 ring-inset ${meta.ring}` : "hover:scale-[1.02] hover:-translate-y-0.5"
        }`}
      >
        {/* 증강 카드 배경 + 등급별 테두리 프레임: 라이엇 CommunityDragon 공식 에셋(아레나/아수라장 증강 선택 화면과 동일) */}
        <div className="absolute inset-0 rounded-2xl" style={{ ...cardArtStyle, backgroundImage: `url(${window.AUGMENT_CARD_BG_URL})` }} />
        <div className="absolute inset-0 rounded-2xl" style={{ ...cardArtStyle, backgroundImage: `url(${window.AUGMENT_CARD_FRAME_URLS[augment.tier]})` }} />

        {/* 카드가 열리는 순간 한 번 훑고 지나가는 빛 */}
        <span className="augment-shine" aria-hidden="true" style={{ animationDelay: `${index * 90 + 120}ms` }} />

        {/* 증강 아이콘: 배지 없이 카드 위쪽에 큼직하게 노출 (실제 게임 카드 비율 참고) */}
        <div className="absolute inset-x-0 z-10 flex items-center justify-center" style={{ top: "10%" }}>
          <AugmentIcon augment={augment} size="w-12 h-12 sm:w-24 sm:h-24" emojiSize="text-3xl sm:text-6xl" />
        </div>

        {/* 본문: 아이콘 아래 남는 공간에서 세로 중앙 정렬 (짧은 설명이어도 여백이 한쪽에 몰리지 않도록) */}
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-center px-2 sm:px-7 pt-[36%] sm:pt-[38%] pb-3 sm:pb-9">
          <span className={`text-[6px] sm:text-[10px] font-black uppercase tracking-wider px-1 sm:px-2 py-0.5 rounded-full bg-black/30 mb-0.5 sm:mb-1 ${meta.accent}`}>
            {meta.label}
          </span>
          <div className="font-augment-name text-[10px] sm:text-base mb-0.5 sm:mb-1 leading-tight text-slate-100">{augment.name}</div>
          <div className="text-[8px] sm:text-xs leading-snug text-slate-400">{augment.desc}</div>
        </div>

        {selected && (
          <div className="absolute top-1 right-1 sm:top-2 sm:right-2 z-10 bg-white text-slate-900 rounded-full w-4 h-4 sm:w-7 sm:h-7 flex items-center justify-center font-black text-[9px] sm:text-sm shadow">
            ✓
          </div>
        )}
      </div>

      {/* 카드별 개별 리롤 버튼: 카드 밖 아래쪽에 따로 위치 (카드와 안 겹침) */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onReroll();
        }}
        disabled={rerollUsed}
        title={
          rerollUsed
            ? "이미 이 카드는 리롤했어요"
            : isGolden
            ? "황금 리롤: 등급이 한 단계 올라가요!"
            : "리롤: 같은 등급 안에서 다시 뽑아요"
        }
        className={`w-6 h-6 sm:w-9 sm:h-9 rounded-full flex items-center justify-center bg-slate-950 border-2 transition-transform hover:scale-110 ${
          rerollUsed
            ? "border-slate-700 text-slate-600 cursor-not-allowed opacity-70"
            : isGolden
            ? "border-amber-300 text-amber-300 shadow-[0_0_14px_rgba(250,204,21,0.8)] animate-pulse"
            : "border-sky-400 text-sky-300 shadow-[0_0_8px_rgba(56,189,248,0.5)]"
        }`}
      >
        {rerollUsed ? <span className="text-xs sm:text-sm font-bold">✓</span> : <RefreshIcon className="w-2.5 h-2.5 sm:w-4 sm:h-4" />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 화면 2: 증강 선택
// ---------------------------------------------------------------------------
function AugmentSelectScreen({ champion, onFinish, onBack }) {
  const [levelIndex, setLevelIndex] = useState(0);

  // 한 게임 동안 "실제로 화면에 뜬 적 있는" 모든 증강 id를 기록 (골랐는지 여부와 무관).
  // 리롤로 스쳐 지나간 카드까지 포함해서, 같은 증강은 한 게임에 두 번 다시 나오지 않도록 함.
  const usedIdsRef = useRef(new Set());
  const markUsed = (ids) => ids.forEach((id) => usedIdsRef.current.add(id));

  const [pools, setPools] = useState(() => {
    const firstPool = makePool(LEVELS[0], [], champion);
    markUsed(firstPool.map((slot) => slot.augment.id));
    return { [LEVELS[0]]: firstPool };
  });
  const [picks, setPicks] = useState({});

  const currentLevel = LEVELS[levelIndex];

  const ensurePool = useCallback((level) => {
    setPools((prev) => {
      if (prev[level]) return prev;
      const newPool = makePool(level, Array.from(usedIdsRef.current), champion);
      markUsed(newPool.map((slot) => slot.augment.id));
      return { ...prev, [level]: newPool };
    });
  }, [champion]);

  const goToLevel = (idx) => {
    setLevelIndex(idx);
    ensurePool(LEVELS[idx]);
  };

  // 증강을 고르면 "다음 레벨" 버튼을 누르지 않아도 잠깐 뒤 자동으로 다음 레벨로 넘어감
  const autoAdvanceTimer = useRef(null);
  useEffect(() => () => clearTimeout(autoAdvanceTimer.current), []);

  // 판도라의 상자 / 전환: 골드·프리즘 같은 "다른 증강으로 바꿔치기" 계열 특수 효과 처리
  const applySpecialEffect = (augment) => {
    if (augment.special === "pandora") {
      // 지금까지 고른 증강 전부(방금 고른 이 카드 포함)를 무작위 프리즘 등급으로 변환
      setPicks((prev) => {
        const baseline = { ...prev, [currentLevel]: augment };
        const converted = {};
        Object.keys(baseline).forEach((lv) => {
          const newAugment = pickOneOfTier("prism", Array.from(usedIdsRef.current), Number(lv), champion);
          markUsed([newAugment.id]);
          converted[lv] = newAugment;
        });
        return converted;
      });
      return;
    }

    if (augment.special === "transmute") {
      // 선택 즉시 지정된 등급의 무작위 증강 하나로 바뀜 (전환: 프리즘 등).
      // 원래 무슨 증강이었는지 알 수 있도록 이름 앞에 "전환: "을 붙여서 보여줌.
      const newAugment = pickOneOfTier(augment.transmuteTier, Array.from(usedIdsRef.current), currentLevel, champion);
      markUsed([newAugment.id]);
      setPicks((prev) => ({
        ...prev,
        [currentLevel]: { ...newAugment, name: `전환: ${newAugment.name}` },
      }));
      return;
    }

    setPicks((prev) => ({ ...prev, [currentLevel]: augment }));
  };

  const handlePick = (augment) => {
    applySpecialEffect(augment);

    clearTimeout(autoAdvanceTimer.current);
    if (levelIndex < LEVELS.length - 1) {
      const nextIdx = levelIndex + 1;
      const nextLevel = LEVELS[nextIdx];
      autoAdvanceTimer.current = setTimeout(() => {
        setPools((prev) => {
          if (prev[nextLevel]) return prev;
          const newPool = makePool(nextLevel, Array.from(usedIdsRef.current), champion);
          markUsed(newPool.map((slot) => slot.augment.id));
          return { ...prev, [nextLevel]: newPool };
        });
        setLevelIndex(nextIdx);
      }, 550);
    }
  };

  // 카드 한 장만 리롤: 같은 등급 안에서 재추첨 (황금 주사위면 한 등급 위로 업그레이드)
  const handleRerollSlot = (slotIndex) => {
    const pool = pools[currentLevel];
    const slot = pool && pool[slotIndex];
    if (!slot || slot.rerollUsed) return;

    const targetTier = slot.isGolden ? nextTier(slot.augment.tier) : slot.augment.tier;
    const newAugment = pickOneOfTier(targetTier, Array.from(usedIdsRef.current), currentLevel, champion);
    markUsed([newAugment.id]);

    setPools((prev) => ({
      ...prev,
      [currentLevel]: prev[currentLevel].map((s, i) =>
        i === slotIndex ? { ...s, augment: newAugment, rerollUsed: true, version: s.version + 1 } : s
      ),
    }));

    // 방금 골라뒀던 카드가 리롤로 사라졌다면 선택도 함께 취소
    setPicks((prev) => {
      if (prev[currentLevel]?.id !== slot.augment.id) return prev;
      const next = { ...prev };
      delete next[currentLevel];
      return next;
    });
  };

  const allPicked = LEVELS.every((lv) => picks[lv]);
  const currentPool = pools[currentLevel] || [];
  const currentPick = picks[currentLevel];

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 pb-40">
      {/* 헤더: 챔피언 + 레벨 탭 */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-8 anim-in">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-200 text-sm shrink-0">
          ← 챔피언 다시 선택
        </button>
        <div className="flex items-center gap-3 sm:ml-auto">
          <ChampionAvatar champion={champion} size="w-12 h-12" textSize="text-base" />
          <div>
            <div className="font-bold">{champion.name}</div>
            <div className="text-xs text-slate-500">{champion.role}</div>
          </div>
        </div>
      </div>

      <div className="flex justify-center gap-1.5 sm:gap-2 mb-8">
        {LEVELS.map((lv, idx) => {
          const isActive = idx === levelIndex;
          const isDone = !!picks[lv];
          return (
            <button
              key={lv}
              onClick={() => goToLevel(idx)}
              className={`relative w-16 sm:w-20 py-2 sm:py-3 rounded-xl font-black text-base sm:text-lg border transition-all ${
                isActive
                  ? "bg-sky-500 border-sky-400 text-white scale-105"
                  : isDone
                  ? "bg-emerald-600/20 border-emerald-500 text-emerald-300"
                  : "bg-slate-900/50 border-slate-700 text-slate-400 hover:border-slate-500"
              }`}
            >
              Lv.{lv}
              {isDone && <span className="absolute -top-2 -right-2 bg-emerald-400 text-slate-900 rounded-full w-5 h-5 text-xs flex items-center justify-center">✓</span>}
            </button>
          );
        })}
      </div>
      <p className="text-center text-xs text-slate-600 -mt-6 mb-8 leading-relaxed">
        💡 실제 아수라장에서는 첫 증강 이후엔 <span className="text-slate-500">사망 후 부활할 때만</span> 다음 증강을 고를 수 있어요.
        <br />
        카드마다 <span className="text-slate-500">리롤(🎲)은 1번씩</span>, 가끔 뜨는{" "}
        <span className="text-amber-500 font-semibold">황금 주사위</span>로 리롤하면 등급이 한 단계 올라가요! (이동은 자유롭게 가능)
      </p>

      {/* 증강 3장 */}
      <h2 className="font-bold text-slate-300 mb-4">Lv.{currentLevel} 증강 선택</h2>

      <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-10 pt-6 sm:pt-8">
        {currentPool.map((slot, i) => (
          <AugmentCard
            // 그 카드가 리롤될 때만 애니메이션이 재생되도록 slot.version을 key에 포함
            key={`${slot.slotId}-${slot.version}`}
            slot={slot}
            index={i}
            selected={currentPick?.id === slot.augment.id}
            onPick={() => handlePick(slot.augment)}
            onReroll={() => handleRerollSlot(i)}
          />
        ))}
      </div>

      {/* 지금까지 쌓인 빌드 슬롯 */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-4">
        <div className="text-sm font-bold text-slate-400 mb-3">내 빌드</div>
        <div className="grid grid-cols-4 gap-3">
          {LEVELS.map((lv) => {
            const picked = picks[lv];
            const meta = picked ? window.TIER_META[picked.tier] : null;
            return (
              <div
                key={lv}
                className={`rounded-xl p-3 border-2 text-center min-h-[92px] flex flex-col items-center justify-center gap-1 bg-slate-900/70 ${
                  picked ? meta.border : "border-dashed border-slate-700"
                }`}
              >
                <div className={`text-[10px] font-bold ${picked ? meta.accent : "text-slate-600"}`}>Lv.{lv}</div>
                {picked ? (
                  <>
                    <AugmentIcon augment={picked} />
                    <div className="font-augment-name text-xs text-slate-100 leading-tight">{picked.name}</div>
                  </>
                ) : (
                  <div className="text-slate-700 text-2xl">?</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 하단 고정: 다음 레벨 / 결과 보기 */}
      <div className="fixed bottom-0 left-0 right-0 bg-slate-950/90 backdrop-blur border-t border-slate-800">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <div className="text-sm text-slate-400">
            {allPicked ? "모든 레벨의 증강을 선택했습니다!" : `${Object.keys(picks).length} / 4 레벨 선택 완료`}
          </div>
          <div className="flex gap-2">
            {!allPicked && levelIndex < LEVELS.length - 1 && (
              <button
                disabled={!currentPick}
                onClick={() => goToLevel(levelIndex + 1)}
                className={`px-5 py-3 rounded-lg font-bold transition-all ${
                  currentPick ? "bg-slate-700 hover:bg-slate-600 text-white" : "bg-slate-800 text-slate-600 cursor-not-allowed"
                }`}
              >
                다음 레벨 →
              </button>
            )}
            <button
              disabled={!allPicked}
              onClick={() => onFinish(picks)}
              className={`px-6 py-3 rounded-lg font-bold transition-all ${
                allPicked
                  ? "bg-gradient-to-r from-emerald-500 to-sky-500 hover:brightness-110 text-white"
                  : "bg-slate-800 text-slate-600 cursor-not-allowed"
              }`}
            >
              결과 확인하기 🏆
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 결과 공유 이미지: 결과 화면을 <canvas>에 직접 그려서 PNG로 만듦.
// (html2canvas 같은 DOM 캡처 라이브러리는 아이콘에 쓰는 CSS mask-image를 지원하지 않아
//  아이콘이 빈 사각형으로 나오기 때문에, 실제 화면과 똑같은 결과물을 위해 직접 캔버스에 그림)
// ---------------------------------------------------------------------------
function loadImageEl(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 하나 실패해도 전체 이미지 생성은 계속 진행
    img.src = url;
  });
}

function drawCoverImage(ctx, img, x, y, w, h) {
  const ir = img.naturalWidth / img.naturalHeight;
  const tr = w / h;
  let sx, sy, sw, sh;
  if (ir > tr) {
    sh = img.naturalHeight;
    sw = sh * tr;
    sx = (img.naturalWidth - sw) / 2;
    sy = 0;
  } else {
    sw = img.naturalWidth;
    sh = sw / tr;
    sx = 0;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// 흰색 실루엣 아이콘 이미지를 등급별 그라데이션으로 틴트해서 그림 (화면의 mask-image와 동일한 효과)
function drawTintedIcon(ctx, img, x, y, size, hexStops) {
  if (!img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = hexStops[hexStops.length - 1];
    ctx.fill();
    ctx.restore();
    return;
  }
  const off = document.createElement("canvas");
  off.width = size * 2;
  off.height = size * 2;
  const octx = off.getContext("2d");
  drawCoverImage(octx, img, 0, 0, off.width, off.height);
  octx.globalCompositeOperation = "source-in";
  const grad = octx.createLinearGradient(0, 0, off.width, off.height);
  hexStops.forEach((c, i) => grad.addColorStop(i / Math.max(hexStops.length - 1, 1), c));
  octx.fillStyle = grad;
  octx.fillRect(0, 0, off.width, off.height);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 10;
  ctx.drawImage(off, x, y, size, size);
  ctx.restore();
}

// 긴 설명을 카드 너비에 맞게 줄바꿈 (단어 단위, 단어 자체가 너무 길면 글자 단위로 쪼갬)
function wrapCanvasText(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
      while (line.length > 1 && ctx.measureText(line).width > maxWidth) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function buildResultShareCanvas(champion, picks) {
  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.ready;
    } catch (e) {
      /* 폰트 로드 확인 실패해도 기본 폰트로 계속 진행 */
    }
  }

  const FONT = `'Pretendard','Noto Sans KR',sans-serif`;
  const W = 1200,
    H = 1020,
    DPR = 2;
  const canvas = document.createElement("canvas");
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext("2d");
  ctx.scale(DPR, DPR);

  // 배경: 실제 페이지와 같은 방사형 그라데이션
  const bgGrad = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.9);
  bgGrad.addColorStop(0, "#1e293b");
  bgGrad.addColorStop(0.55, "#0b0f19");
  bgGrad.addColorStop(1, "#05070c");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  const OM = 32,
    P = 40;
  const panelX = OM,
    panelY = OM,
    panelW = W - OM * 2,
    panelH = H - OM * 2;
  ctx.fillStyle = "rgba(15,23,42,0.7)";
  roundRectPath(ctx, panelX, panelY, panelW, panelH, 28);
  ctx.fill();
  ctx.strokeStyle = "rgba(51,65,85,0.8)";
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, panelX, panelY, panelW, panelH, 28);
  ctx.stroke();

  ctx.fillStyle = "#34d399";
  ctx.font = `800 15px ${FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("🏆 아수라장(증바람) 빌드 완성!", panelX + P, panelY + P + 14);

  // 챔피언 아바타 + 이름
  const avatarSize = 88;
  const avatarX = panelX + P;
  const avatarY = panelY + P + 34;
  const champImg = await loadImageEl(window.getChampionImageUrl(champion.id));
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (champImg) {
    drawCoverImage(ctx, champImg, avatarX, avatarY, avatarSize, avatarSize);
  } else {
    ctx.fillStyle = "#334155";
    ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(148,163,184,0.4)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  const nameX = avatarX + avatarSize + 24;
  ctx.fillStyle = "#f1f5f9";
  ctx.font = `900 30px ${FONT}`;
  ctx.fillText(champion.name, nameX, avatarY + 38);
  ctx.fillStyle = "#94a3b8";
  ctx.font = `600 17px ${FONT}`;
  ctx.fillText(champion.role, nameX, avatarY + 66);

  // 증강 카드 2x2 그리드
  const gridTop = avatarY + avatarSize + 36;
  const gap = 24;
  const tileW = (panelW - P * 2 - gap) / 2;
  const tileH = 300;

  const iconImgs = await Promise.all(LEVELS.map((lv) => loadImageEl(picks[lv].iconUrl)));

  LEVELS.forEach((lv, i) => {
    const a = picks[lv];
    const meta = window.TIER_META[a.tier];
    const col = i % 2,
      row = Math.floor(i / 2);
    const tx = panelX + P + col * (tileW + gap);
    const ty = gridTop + row * (tileH + gap);

    ctx.save();
    if (a.tier === "prism") {
      ctx.shadowColor = "rgba(217,70,239,0.45)";
      ctx.shadowBlur = 22;
    } else if (a.tier === "gold") {
      ctx.shadowColor = "rgba(250,204,21,0.35)";
      ctx.shadowBlur = 16;
    }
    ctx.fillStyle = "rgba(15,23,42,0.75)";
    roundRectPath(ctx, tx, ty, tileW, tileH, 20);
    ctx.fill();
    ctx.restore();

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = meta.hex.border;
    roundRectPath(ctx, tx, ty, tileW, tileH, 20);
    ctx.stroke();

    const tp = 26;

    ctx.font = `800 15px ${FONT}`;
    const chipText = `LV.${lv} · ${meta.label}`;
    const chipTextW = ctx.measureText(chipText).width;
    const chipPadX = 14,
      chipH = 30;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    roundRectPath(ctx, tx + tp, ty + tp, chipTextW + chipPadX * 2, chipH, chipH / 2);
    ctx.fill();
    ctx.fillStyle = meta.hex.stops[meta.hex.stops.length - 1];
    ctx.fillText(chipText, tx + tp + chipPadX, ty + tp + chipH / 2 + 5);

    const iconSize = 64;
    drawTintedIcon(ctx, iconImgs[i], tx + tileW - tp - iconSize, ty + tp - 5, iconSize, meta.hex.stops);

    ctx.fillStyle = "#f1f5f9";
    ctx.font = `800 24px ${FONT}`;
    const nameY = ty + tp + chipH + 42;
    ctx.fillText(a.name, tx + tp, nameY);

    ctx.fillStyle = "#94a3b8";
    ctx.font = `500 16px ${FONT}`;
    const descLines = wrapCanvasText(ctx, a.desc, tileW - tp * 2);
    descLines.slice(0, 5).forEach((line, li) => {
      ctx.fillText(line, tx + tp, nameY + 32 + li * 23);
    });
  });

  const footerY = gridTop + tileH * 2 + gap + 34;
  ctx.strokeStyle = "rgba(51,65,85,0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(panelX + P, footerY - 20);
  ctx.lineTo(panelX + panelW - P, footerY - 20);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = "#64748b";
  ctx.font = `600 15px ${FONT}`;
  ctx.fillText("무작위 총력전: 아수라장(증바람) 증강 뽑기 시뮬레이터", W / 2, footerY);
  ctx.fillStyle = "#475569";
  ctx.font = `400 13px ${FONT}`;
  ctx.fillText("sangkeum4281-rgb.github.io/lol-augment-simulator", W / 2, footerY + 22);
  ctx.textAlign = "left";

  return canvas;
}

// ---------------------------------------------------------------------------
// 화면 3: 최종 결과
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 궁합도 게이지: 뽑은 증강이 챔피언 역할군과 얼마나 어울리는지 점수로 보여줌
// ---------------------------------------------------------------------------
function SynergyMeter({ champion, picks }) {
  const synergy = useMemo(
    () => window.computeSynergy(champion, LEVELS.map((lv) => picks[lv])),
    [champion, picks]
  );
  const { pct, verdict, topTags } = synergy;

  const barColor =
    pct >= 85 ? "from-emerald-400 to-teal-300" :
    pct >= 70 ? "from-sky-400 to-cyan-300" :
    pct >= 50 ? "from-amber-400 to-yellow-300" :
    pct >= 30 ? "from-orange-500 to-amber-400" :
    "from-rose-500 to-red-400";

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 mb-6 anim-in">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-bold text-slate-300">🧩 {champion.role} 궁합도</span>
        <span className="text-2xl font-black">
          {pct}
          <span className="text-sm text-slate-500 font-bold">점</span>
        </span>
      </div>
      <div className="h-3 rounded-full bg-slate-800 overflow-hidden mb-3">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${barColor} transition-all duration-700`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-sm text-slate-300">{verdict}</p>
      {topTags.length > 0 && (
        <p className="text-xs text-slate-500 mt-1">핵심 키워드: {topTags.join(" · ")}</p>
      )}
    </div>
  );
}

function ResultScreen({ champion, picks, onRestart }) {
  // idle(대기) | generating(이미지 생성 중) | ready(생성 완료, 미리보기 표시) | copied(복사됨) | error(실패)
  const [shareStatus, setShareStatus] = useState("idle");
  const [shareImage, setShareImage] = useState(null); // { url, blob, fileName }

  // 화면을 벗어나면 만들어둔 objectURL 정리
  useEffect(() => {
    return () => {
      if (shareImage) URL.revokeObjectURL(shareImage.url);
    };
  }, [shareImage]);

  const canNativeShare = typeof navigator !== "undefined" && !!navigator.canShare;
  const canClipboardImage = typeof navigator !== "undefined" && !!navigator.clipboard && typeof window.ClipboardItem !== "undefined";

  const generateShareImage = async () => {
    setShareStatus("generating");
    try {
      const canvas = await buildResultShareCanvas(champion, picks);
      canvas.toBlob((blob) => {
        if (!blob) {
          setShareStatus("error");
          return;
        }
        const fileName = `아수라장_${champion.name}_빌드.png`;
        const url = URL.createObjectURL(blob);
        setShareImage((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return { url, blob, fileName };
        });
        setShareStatus("ready");
      }, "image/png");
    } catch (e) {
      console.error(e);
      setShareStatus("error");
    }
  };

  const handleNativeShare = async () => {
    if (!shareImage) return;
    const file = new File([shareImage.blob], shareImage.fileName, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "아수라장(증바람) 빌드 결과", text: `${champion.name} 빌드 완성!` });
      } catch (e) {
        /* 사용자가 취소한 경우 등은 무시 */
      }
    }
  };

  const handleCopyImage = async () => {
    if (!shareImage || !canClipboardImage) return;
    try {
      await navigator.clipboard.write([new window.ClipboardItem({ "image/png": shareImage.blob })]);
      setShareStatus("copied");
      setTimeout(() => setShareStatus("ready"), 2000);
    } catch (e) {
      setShareStatus("error");
    }
  };

  const handleDownloadImage = () => {
    if (!shareImage) return;
    const a = document.createElement("a");
    a.href = shareImage.url;
    a.download = shareImage.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <div className="text-center mb-8 anim-in">
        <p className="text-emerald-400 font-semibold tracking-widest text-sm mb-2">BUILD COMPLETE</p>
        <h1 className="font-title text-3xl font-black">최종 빌드 결과</h1>
      </div>

      <SynergyMeter champion={champion} picks={picks} />

      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 mb-6 anim-in">
        <div className="flex items-center gap-4 mb-6">
          <ChampionAvatar champion={champion} size="w-20 h-20" textSize="text-2xl" />
          <div>
            <div className="text-2xl font-black">{champion.name}</div>
            <div className="text-slate-400">{champion.role}</div>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          {LEVELS.map((lv) => {
            const a = picks[lv];
            const meta = window.TIER_META[a.tier];
            return (
              <div
                key={lv}
                className={`relative overflow-hidden rounded-xl p-4 border-2 bg-slate-900/70 ${meta.border} ${meta.glow}`}
              >
                {a.tier === "prism" && <div className="absolute inset-0 prism-shimmer pointer-events-none" />}
                <div className="relative z-10">
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-[11px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-black/30 ${meta.accent}`}>
                      Lv.{lv} · {meta.label}
                    </span>
                    <AugmentIcon augment={a} />
                  </div>
                  <div className="font-augment-name text-slate-100">{a.name}</div>
                  <div className="text-sm text-slate-400">{a.desc}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={onRestart}
          className="flex-1 px-6 py-3 rounded-lg font-bold bg-slate-800 hover:bg-slate-700 border border-slate-600 transition-colors"
        >
          🔄 다시 하기
        </button>
        <button
          onClick={generateShareImage}
          disabled={shareStatus === "generating"}
          className={`flex-1 px-6 py-3 rounded-lg font-bold text-white transition-all ${
            shareStatus === "generating"
              ? "bg-slate-700 cursor-wait"
              : "bg-gradient-to-r from-sky-500 to-fuchsia-500 hover:brightness-110"
          }`}
        >
          {shareStatus === "generating" ? "이미지 만드는 중..." : "🖼️ 이 화면 이미지로 공유하기"}
        </button>
      </div>

      {shareImage && (
        <div className="mt-6 bg-slate-900/60 border border-slate-800 rounded-2xl p-4 anim-in">
          <img src={shareImage.url} alt="빌드 결과 공유 이미지" className="w-full rounded-xl border border-slate-700" />
          <p className="text-center text-xs text-slate-500 mt-3">
            📱 모바일: 이미지를 길게 눌러 저장하거나 공유할 수 있어요 · 💻 PC: 이미지 우클릭 → "이미지 복사"로 카톡 등에 바로 붙여넣기 가능
          </p>
          <div className="flex flex-wrap justify-center gap-2 mt-3">
            {canNativeShare && (
              <button
                onClick={handleNativeShare}
                className="px-4 py-2 rounded-lg text-sm font-bold bg-gradient-to-r from-sky-500 to-fuchsia-500 hover:brightness-110 text-white transition-all"
              >
                📤 공유하기
              </button>
            )}
            {canClipboardImage && (
              <button
                onClick={handleCopyImage}
                className="px-4 py-2 rounded-lg text-sm font-bold bg-slate-800 hover:bg-slate-700 border border-slate-600 transition-colors"
              >
                {shareStatus === "copied" ? "✅ 복사됨!" : "📋 이미지 복사"}
              </button>
            )}
            <button
              onClick={handleDownloadImage}
              className="px-4 py-2 rounded-lg text-sm font-bold bg-slate-800 hover:bg-slate-700 border border-slate-600 transition-colors"
            >
              ⬇️ 다운로드
            </button>
          </div>
        </div>
      )}

      {shareStatus === "error" && (
        <p className="text-center text-sm text-rose-400 mt-3">이미지 생성에 실패했어요. 다시 시도해주세요.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 루트 앱: 화면 전환 관리
// ---------------------------------------------------------------------------
function App() {
  const [stage, setStage] = useState("champion"); // champion | augment | result
  const [champion, setChampion] = useState(null);
  const [finalPicks, setFinalPicks] = useState(null);

  const handleRestart = () => {
    setChampion(null);
    setFinalPicks(null);
    setStage("champion");
  };

  return (
    <div>
      {stage === "champion" && (
        <ChampionSelectScreen
          onConfirm={(c) => {
            setChampion(c);
            setStage("augment");
          }}
        />
      )}
      {stage === "augment" && champion && (
        <AugmentSelectScreen
          champion={champion}
          onBack={() => setStage("champion")}
          onFinish={(picks) => {
            setFinalPicks(picks);
            setStage("result");
            logPick(champion, picks); // 완성 즉시 기록, 실패해도 화면 전환은 그대로 진행
          }}
        />
      )}
      {stage === "result" && champion && finalPicks && (
        <ResultScreen champion={champion} picks={finalPicks} onRestart={handleRestart} />
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
