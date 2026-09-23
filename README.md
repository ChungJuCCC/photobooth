# 셀프 포토부스

세로로 세운 안드로이드 태블릿에서 손님이 직접 찍고, QR로 사진과 타임랩스를 받아가는 포토부스.

- 6장 촬영 → 4장 선택 → 세로 4컷 / 바둑판 프레임으로 합성
- 촬영 전체를 3배속 타임랩스(MP4)로 자동 생성
- QR을 찍으면 손님 폰에서 사진·영상 저장. **업로드 후 24시간 지나면 삭제**
- 인터넷이 끊겨도 촬영 가능. 기기에 보관했다가 연결되면 자동 업로드
- 운영자가 태블릿에서 PNG 프레임을 등록하면 모든 태블릿에 공유

**처음 설치는 [docs/SETUP.md](docs/SETUP.md)를 따라 하세요.**
설계와 결정 이유는 [docs/specs/2026-09-17-photobooth-apk-design.md](docs/specs/2026-09-17-photobooth-apk-design.md)에 있습니다.

## 구성

```
app/                    태블릿 앱 (Capacitor 8 → APK)
  www/                  화면과 로직 (빌드 도구 없이 순수 JS 모듈)
    js/main.js          촬영 → 선택 → 결과 흐름
    js/timelapse.js     WebCodecs H.264 타임랩스
    js/queue.js         오프라인 업로드 대기열 (IndexedDB)
    js/admin.js         PIN · 프레임 등록
    js/layouts.js       레이아웃 규격, 프레임 검사 규칙
  android/              안드로이드 프로젝트 (세로 고정, 화면 꺼짐 방지, 전체 화면)
  tests/                프레임 규칙 테스트

web/                    손님용 사진 받기 페이지 (Vercel, Root Directory = web)

supabase/
  migrations/           테이블, PIN 함수, 저장소 버킷, 매시간 삭제 예약
  functions/            Edge Functions 6개
    _shared/handlers.ts   요청 처리 (Supabase와 무관한 순수 로직)
    _shared/supabase-deps.ts  실제 Supabase 연결
  tests/                함수 로직 테스트

dev/mock-server.ts      계정 없이 로컬에서 전체를 돌려보는 가짜 서버
.github/workflows/      태그를 올리면 APK를 빌드해 Releases에 첨부
```

## 로컬에서 돌려보기

```bash
node dev/mock-server.ts
```

http://localhost:8787/app/ 을 열면 태블릿 앱, 관리자 PIN은 `1234`.
실제 함수 코드를 메모리 저장소로 실행하므로 업로드·만료·삭제·PIN 잠금이 실제와 같은 규칙으로 동작합니다.

```bash
node --test "supabase/tests/*.test.ts"
```

```bash
node --test "app/tests/*.test.mjs"
```

## 이전 버전

루트의 `index.html`과 `frames/`는 이전 단일 HTML 웹 버전입니다. 새 앱에서는 쓰지 않으며 참고용으로 남겨두었습니다.
