# 무작위 총력전: 아수라장(증바람) - 증강 뽑기 시뮬레이터

빌드 툴 없이 브라우저에서 바로 실행되는 토이 웹 앱입니다.
React(UMD) + Babel standalone + Tailwind(CDN)을 스크립트 태그로 불러와 사용하며,
챔피언/증강 데이터는 `js/data.js`에 Mock JSON 형태(JS 객체)로 정의되어 있습니다.

## 실행 방법

### 방법 1. 그냥 열기 (가장 빠름)
`index.html` 파일을 더블클릭하거나 브라우저로 드래그해서 열면 바로 실행됩니다.

### 방법 2. 로컬 서버로 실행 (권장)
일부 브라우저 보안 정책 때문에 `file://`로 열면 스크립트가 막히는 경우가 있습니다.
그럴 땐 이 폴더에서 간단한 정적 서버를 띄우세요.

```bash
cd lol-augment-simulator
python3 -m http.server 5500
# 브라우저에서 http://localhost:5500 접속
```

또는 Node가 있다면:

```bash
npx serve .
```

## 파일 구조

```
lol-augment-simulator/
├── index.html        # 엔트리 포인트. CDN 스크립트 로드 + <div id="root">
├── js/
│   ├── data.js        # Mock 데이터: CHAMPIONS, AUGMENTS, 레벨별 등급 가중치, 등급별 스타일 메타
│   └── app.js          # React 앱 전체 로직 (JSX, Babel이 브라우저에서 즉시 변환)
└── README.md
```

## 화면 흐름

1. **챔피언 선택** — 검색창으로 챔피언을 찾고 카드 클릭 → 하단 바에서 확정
   - 챔피언 이미지는 Riot Data Dragon CDN(`ddragon.leagueoflegends.com`)에서 불러오며,
     이미지 로드 실패 시 이니셜 원형 아이콘으로 자동 대체됩니다.
2. **증강 선택** — 3 / 7 / 11 / 15레벨 탭을 이동하며 각 단계마다 무작위 증강 3개 중 1개 선택
   - 등급: 실버(회색) / 골드(금색, 은은한 글로우) / 프리즘(무지개, 반짝이는 애니메이션)
   - 레벨이 높을수록 골드·프리즘 등장 확률이 올라가도록 가중치가 설정되어 있습니다 (`js/data.js`의 `LEVEL_TIER_WEIGHTS`).
   - 🎲 리롤 버튼으로 해당 레벨의 3개 카드를 다시 무작위로 뽑을 수 있습니다 (횟수 제한 없음).
   - 이미 다른 레벨에서 선택한 증강은 다음 뽑기 풀에서 제외되어 중복을 최소화합니다.
   - 하단 "내 빌드" 슬롯에 선택한 증강이 실시간으로 쌓입니다.
3. **최종 결과** — 챔피언 + 4개 증강 요약 카드
   - "다시 하기": 처음부터 새로 시작
   - "친구에게 공유하기": 모바일에서는 OS 공유 시트(`navigator.share`), 데스크톱에서는 클립보드 복사(실패 시 텍스트 박스로 수동 복사)

## 데이터 교체하기 (실서비스 연동 시)

`js/data.js`의 `window.CHAMPIONS`, `window.AUGMENTS`를 실제 API 응답으로 바꾸기만 하면 됩니다.
예를 들어 Riot Data Dragon 챔피언 목록 API로 교체하려면:

```js
fetch(`https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/data/ko_KR/champion.json`)
  .then(res => res.json())
  .then(data => {
    window.CHAMPIONS = Object.values(data.data).map(c => ({
      id: c.id, name: c.name, role: c.tags[0],
    }));
  });
```

`js/data.js` 최상단의 `DDRAGON_VERSION` 값이 오래되어 챔피언 이미지가 깨진다면,
[Data Dragon 버전 목록](https://ddragon.leagueoflegends.com/api/versions.json)에서 최신 버전으로 교체해주세요.

## 커스터마이징 포인트

- 증강 개수/설명/등급 확률: `js/data.js`의 `AUGMENTS`, `LEVEL_TIER_WEIGHTS`
- 카드 색상/글로우: `js/data.js`의 `TIER_META`
- 화면 로직: `js/app.js` (컴포넌트별로 분리되어 있어 수정이 쉽습니다)
