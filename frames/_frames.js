/* ═══════════════════════════════════════════════════════════════════════
   프레임 설정 파일   frames/_frames.js
   ═══════════════════════════════════════════════════════════════════════

   ┌─ 새 프레임(PNG)을 추가하고 싶다면 ────────────────────────────────┐
   │                                                                    │
   │  1) PNG 파일을 이 frames/ 폴더에 그대로 넣으세요.                  │
   │       · 사진이 들어갈 자리는 반드시 "투명(알파)"이어야 합니다.      │
   │       · 크기는 아래 LAYOUTS의 w × h 와 똑같이 맞춰주세요.           │
   │                                                                    │
   │  2) 맨 아래 FRAMES 배열에 한 줄 추가하세요.                        │
   │       { id:'g-01', name:'내 프레임', layout:'grid',                │
   │         src:'frames/g-01.png' },                                   │
   │                                                                    │
   │  3) 저장 → 브라우저 새로고침. 끝!                                  │
   │                                                                    │
   └────────────────────────────────────────────────────────────────────┘

   ※ layout 값은 'vertical' | 'grid' 둘 중 하나입니다.
   ※ src 를 생략하면 코드가 기본 프레임을 직접 그립니다(PNG 불필요).
   ※ 프레임 객체에 w/h/slots 를 직접 넣으면 그 프레임만 다른 규격을
     쓸 수 있습니다. (기본 흑백 프레임들이 이 방식을 씁니다)
   ═══════════════════════════════════════════════════════════════════════ */


/* ───────────────────────────────────────────────────────────────────────
   1. 레이아웃 — 캔버스 크기와 사진 슬롯 좌표 (PNG 프레임을 만들 때의 규격)
   ─────────────────────────────────────────────────────────────────────── */

const PHOTO_RATIO = 499 / 396;   // 사진 한 칸의 가로:세로 비율 (모든 레이아웃 공통)

const LAYOUTS = {

  /* 세로 4컷 — 기존 충주CCC PNG 프레임 7종과 100% 호환되는 규격 */
  vertical: {
    key: 'vertical',
    label: '세로 4컷',
    en: 'VERTICAL',
    desc: '길쭉한 기본 인생네컷',
    w: 591, h: 1772,
    slots: [
      { x: 46, y:   90, w: 499, h: 397 },
      { x: 46, y:  504, w: 499, h: 396 },
      { x: 46, y:  916, w: 499, h: 396 },
      { x: 46, y: 1329, w: 499, h: 396 },
    ],
  },

  /* 바둑판 2×2 — 인스타 피드용 */
  grid: {
    key: 'grid',
    label: '바둑판 2×2',
    en: 'GRID',
    desc: '정사각에 가까운 피드용',
    w: 1080, h: 1200,
    slots: [
      { x:  40, y: 175, w: 487, h: 386 },
      { x: 553, y: 175, w: 487, h: 386 },
      { x:  40, y: 587, w: 487, h: 386 },
      { x: 553, y: 587, w: 487, h: 386 },
    ],
  },
};


/* ───────────────────────────────────────────────────────────────────────
   2. 프레임에 인쇄될 문구 — 여기만 바꾸면 전부 반영됩니다
   ─────────────────────────────────────────────────────────────────────── */

const BRAND = {
  wordmark: 'CHUNGJU CCC',              // 프레임 하단 큰 로고 (영문 대문자 권장)
  title:    '충주CCC 포토부스',
  subtitle: '2026 여름수련회',
  tagline:  'FIRST NO MATTER WHAT',
};


/* ───────────────────────────────────────────────────────────────────────
   3. 기본 프레임 팔레트 — 흑백 모노톤
   ─────────────────────────────────────────────────────────────────────── */

const PALETTES = {
  white: { name:'화이트', en:'WHITE', bg:'#FFFFFF', ink:'#111111', sub:'#9A9A9A', line:'#E4E4E4', film:false },
  black: { name:'블랙',   en:'BLACK', bg:'#0C0C0C', ink:'#FFFFFF', sub:'#7A7A7A', line:'#2A2A2A', film:false },
  film:  { name:'필름',   en:'FILM',  bg:'#141414', ink:'#FFFFFF', sub:'#8A8A8A', line:'#2E2E2E', film:true  },
  ash:   { name:'애쉬',   en:'ASH',   bg:'#E9E8E4', ink:'#1A1A1A', sub:'#8C8A84', line:'#D2D0CA', film:false },
};


/* ───────────────────────────────────────────────────────────────────────
   4. 기본 프레임 규격 (PNG 없이 코드로 그리는 프레임 전용)
      아래쪽에 로고가 들어갈 여백을 확보한 별도 규격을 씁니다.
   ─────────────────────────────────────────────────────────────────────── */

const BUILTIN_GEO = {
  vertical: {
    w: 600, h: 1800,
    slots: [
      { x: 55, y:   30, w: 490, h: 389 },
      { x: 55, y:  433, w: 490, h: 389 },
      { x: 55, y:  836, w: 490, h: 389 },
      { x: 55, y: 1239, w: 490, h: 389 },
    ],
    bandTop: 1628,        // 로고 영역 시작 y
  },
  grid: {
    w: 1080, h: 1032,
    slots: [
      { x:  40, y:  40, w: 492, h: 390 },
      { x: 548, y:  40, w: 492, h: 390 },
      { x:  40, y: 446, w: 492, h: 390 },
      { x: 548, y: 446, w: 492, h: 390 },
    ],
    bandTop: 836,
  },
};


/* ───────────────────────────────────────────────────────────────────────
   5. 기본 프레임 그리기
      · paintBackground : 사진 깔기 "전"에 그려지는 배경
      · paintOverlay    : 사진 깔은 "후"에 그려지는 하이라인 + 로고
   ─────────────────────────────────────────────────────────────────────── */

/* 자간(letter-spacing)을 준 가운데 정렬 텍스트.
   ctx.letterSpacing 은 사파리 구버전에서 안 먹어서 직접 그립니다. */
function drawTracked(ctx, text, cx, y, spacing){
  const chars = Array.from(text);
  let total = 0;
  for (const ch of chars) total += ctx.measureText(ch).width + spacing;
  total -= spacing;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  let x = cx - total / 2;
  for (const ch of chars){
    ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width + spacing;
  }
  ctx.textAlign = prevAlign;
}

function makeBuiltinFrame(layoutKey, paletteKey){
  const G = BUILTIN_GEO[layoutKey];
  const P = PALETTES[paletteKey];
  const isGrid = layoutKey === 'grid';

  return {
    id:      'built-' + layoutKey + '-' + paletteKey,
    name:    P.name,
    en:      P.en,
    layout:  layoutKey,
    builtin: true,
    slotRadius: 0,                       // 미니멀: 모서리를 깎지 않습니다
    w: G.w, h: G.h, slots: G.slots,

    paintBackground(ctx){
      ctx.fillStyle = P.bg;
      ctx.fillRect(0, 0, G.w, G.h);

      // 필름 변형: 양쪽 가장자리에 퍼포레이션(필름 구멍)
      if (P.film){
        ctx.fillStyle = P.bg === '#141414' ? '#000000' : '#FFFFFF';
        ctx.globalAlpha = .55;
        const hw = 13, hh = 20, gap = 34;
        for (let y = 26; y < G.h - hh; y += gap){
          ctx.fillRect(12, y, hw, hh);
          ctx.fillRect(G.w - 12 - hw, y, hw, hh);
        }
        ctx.globalAlpha = 1;
      }
    },

    paintOverlay(ctx){
      // 사진 둘레 헤어라인 1px
      ctx.save();
      ctx.strokeStyle = P.line;
      ctx.lineWidth = 2;
      for (const s of G.slots) ctx.strokeRect(s.x - 1, s.y - 1, s.w + 2, s.h + 2);
      ctx.restore();

      // ── 하단 로고 밴드 ─────────────────────────────────────────
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';

      const cx   = G.w / 2;
      const band = G.h - G.bandTop;
      const top  = G.bandTop;

      // 얇은 구분선
      ctx.strokeStyle = P.line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(G.slots[0].x, top + band * 0.30);
      ctx.lineTo(G.w - G.slots[0].x, top + band * 0.30);
      ctx.stroke();

      // 워드마크 (자간 넓은 대문자)
      ctx.fillStyle = P.ink;
      const wmSize = isGrid ? 46 : 40;
      ctx.font = '600 ' + wmSize + "px Archivo, 'Noto Sans KR', sans-serif";
      drawTracked(ctx, BRAND.wordmark, cx, top + band * 0.615, wmSize * 0.20);

      // 부제 + 태그라인
      ctx.fillStyle = P.sub;
      const subSize = isGrid ? 22 : 19;
      ctx.font = '400 ' + subSize + "px Archivo, 'Noto Sans KR', sans-serif";
      drawTracked(ctx, BRAND.subtitle + '   ·   ' + BRAND.tagline, cx, top + band * 0.855, subSize * 0.14);

      ctx.restore();
    },
  };
}


/* ───────────────────────────────────────────────────────────────────────
   6. 프레임 목록  ★ 여기에 추가하세요 ★
   ─────────────────────────────────────────────────────────────────────── */

const FRAMES = [

  /* ── 세로 4컷 : 코드로 그리는 흑백 기본 프레임 ────────────────────── */
  makeBuiltinFrame('vertical', 'white'),
  makeBuiltinFrame('vertical', 'black'),
  makeBuiltinFrame('vertical', 'film'),
  makeBuiltinFrame('vertical', 'ash'),

  /* ── 세로 4컷 : 기존 충주CCC PNG 프레임 7종 (컬러) ────────────────── */
  { id:'v-01', name:'CCC 01', en:'CCC 01', layout:'vertical', src:'frames/v-01.png' },
  { id:'v-02', name:'CCC 02', en:'CCC 02', layout:'vertical', src:'frames/v-02.png' },
  { id:'v-03', name:'CCC 03', en:'CCC 03', layout:'vertical', src:'frames/v-03.png' },
  { id:'v-04', name:'CCC 04', en:'CCC 04', layout:'vertical', src:'frames/v-04.png' },
  { id:'v-05', name:'CCC 05', en:'CCC 05', layout:'vertical', src:'frames/v-05.png' },
  { id:'v-06', name:'CCC 06', en:'CCC 06', layout:'vertical', src:'frames/v-06.png' },
  { id:'v-07', name:'CCC 07', en:'CCC 07', layout:'vertical', src:'frames/v-07.png' },

  /* ── 바둑판 2×2 : 코드로 그리는 흑백 기본 프레임 ──────────────────── */
  makeBuiltinFrame('grid', 'white'),
  makeBuiltinFrame('grid', 'black'),
  makeBuiltinFrame('grid', 'film'),
  makeBuiltinFrame('grid', 'ash'),
  // ↓ 바둑판용 PNG를 만들면 이런 식으로 추가하세요 (1080 × 1200, 투명 PNG)
  // { id:'g-01', name:'내 바둑판', layout:'grid', src:'frames/g-01.png' },
];


/* ───────────────────────────────────────────────────────────────────────
   7. 앱에 넘겨주기 (이 아래는 건드리지 마세요)
   ─────────────────────────────────────────────────────────────────────── */

window.PHOTOBOOTH = {
  LAYOUTS,
  PHOTO_RATIO,
  BRAND,
  FRAMES: FRAMES.map(f => {
    const L = LAYOUTS[f.layout];
    if (!L){ console.error('알 수 없는 layout:', f.layout, f); return null; }
    return Object.assign({
      w: L.w, h: L.h, slots: L.slots, slotRadius: 0, builtin: false, bg: '#0C0C0C',
    }, f);
  }).filter(Boolean),
};
