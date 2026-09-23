# 설치 안내서

운영 계정(GitHub · Supabase · Vercel) 주인이 처음 한 번 따라 하는 순서입니다.
전부 무료 플랜, 결제 카드 등록 없이 진행됩니다.

순서가 중요합니다: **Supabase → Vercel → GitHub 설정 → APK 빌드 → 태블릿 설치**.
앞 단계에서 나온 값을 뒤 단계에 넣습니다.

준비물: Node.js 20 이상이 설치된 PC 한 대 (명령어 실행용).

---

## 0. 비밀값 미리 만들기

PC 터미널에서 아래를 **두 번** 실행해서 나온 값을 메모장에 적어두세요.

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

| 이름 | 쓰임 |
|---|---|
| `BOOTH_KEY` | 태블릿 앱이 서버에 자기가 포토부스라고 알리는 값 |
| `CLEANUP_TOKEN` | 매시간 삭제 작업이 서버에 자기를 증명하는 값 |

관리자 PIN 4자리도 정해두세요. 프레임을 등록할 때 씁니다.

---

## 1. GitHub 저장소

1. GitHub에서 **새 저장소**를 만듭니다 (비공개 권장).
2. 이 프로젝트 폴더를 그 저장소에 올립니다.

올리기 전에 `web/config.js`, `app/www/config.js`에 실제 키가 들어가 있지 않은지 확인하세요.
(`app/www/config.js`는 빌드할 때 GitHub 설정값으로 자동 생성되므로 저장소에는 빈 값 그대로 둡니다.)

---

## 2. Supabase

### 2-1. 프로젝트 만들기

1. supabase.com 가입 후 **New project**
2. Region: **Northeast Asia (Seoul)**
3. DB 비밀번호는 안전한 곳에 보관

### 2-2. DB와 함수 올리기

프로젝트 폴더에서:

```bash
npx supabase login
```

```bash
npx supabase link --project-ref 프로젝트REF
```

프로젝트 REF는 대시보드 **Project Settings → General → Reference ID**에 있습니다.
`supabase/config.toml`의 `project_id`도 같은 값으로 바꿔주세요.

```bash
npx supabase db push
```

```bash
npx supabase secrets set BOOTH_KEY=0단계값 CLEANUP_TOKEN=0단계값
```

```bash
npx supabase functions deploy
```

### 2-3. SQL 편집기에서 세 줄 실행

대시보드 **SQL Editor**에서 실행합니다. `<...>` 부분을 바꿔 넣으세요.

```sql
select public.set_admin_pin('<관리자 PIN 4자리>');
select vault.create_secret('https://<프로젝트REF>.supabase.co', 'project_url');
select vault.create_secret('<CLEANUP_TOKEN 값>', 'cleanup_token');
```

마지막 두 줄이 있어야 **매시간 만료된 사진이 실제로 지워집니다.**

### 2-4. 키 복사

**Project Settings → API Keys**에서 **Publishable key** (`sb_publishable_...`)를 복사해두세요.
Secret key는 어디에도 넣지 않습니다.

### 2-5. (선택) 기존 계정을 팀원으로 초대

Organization **Team**에서 초대할 때 역할은 반드시 **Developer**로 주세요.
Owner나 Admin으로 초대하면 그 사람의 무료 프로젝트 개수에 합산되어 문제가 생깁니다.

---

## 3. Vercel (손님용 사진 받기 페이지)

1. `web/config.js`를 수정하고 GitHub에 올립니다.

   ```js
   window.GUEST_CONFIG = {
     functionsUrl: "https://<프로젝트REF>.supabase.co/functions/v1",
     publishableKey: "sb_publishable_...",
     eventName: "",
   };
   ```

2. vercel.com에서 **Add New → Project** → 1단계 저장소 선택
3. **Root Directory: `web`**, Framework Preset: **Other**, 빌드 설정은 비워둡니다
4. 배포가 끝나면 주소를 확인합니다. 예: `https://photobooth-abc.vercel.app`

손님 페이지 주소는 여기에 `/s`를 붙인 값입니다: `https://photobooth-abc.vercel.app/s`

---

## 4. APK 서명 키 만들기 (처음 한 번)

⚠️ **이 키를 잃어버리면 태블릿에 업데이트를 설치할 수 없습니다.** 앱을 지우고 새로 깔아야 하고, 기기에 남아 있던 업로드 대기 사진도 사라집니다. 파일과 비밀번호를 두 곳 이상에 보관하세요.

JDK가 설치된 PC에서:

```bash
keytool -genkeypair -v -keystore photobooth-release.jks -alias photobooth -keyalg RSA -keysize 2048 -validity 10000
```

비밀번호를 두 번(저장소, 키) 묻습니다. 같은 값을 써도 됩니다.

GitHub에 넣을 수 있게 한 줄 텍스트로 바꿉니다:

```bash
node -e "console.log(require('fs').readFileSync('photobooth-release.jks').toString('base64'))"
```

`.jks` 파일은 **절대 저장소에 올리지 마세요** (`.gitignore`에 막혀 있습니다).

---

## 5. GitHub 설정값

저장소 **Settings → Secrets and variables → Actions**

**Variables** 탭:

| 이름 | 값 |
|---|---|
| `FUNCTIONS_URL` | `https://<프로젝트REF>.supabase.co/functions/v1` |
| `PUBLISHABLE_KEY` | `sb_publishable_...` |
| `GUEST_PAGE_URL` | `https://<vercel 주소>/s` |
| `EVENT_NAME` | 프레임·영상에 들어갈 행사명 (비워도 됨) |

**Secrets** 탭:

| 이름 | 값 |
|---|---|
| `BOOTH_KEY` | 0단계 값 (Supabase에 넣은 것과 같아야 함) |
| `ANDROID_KEYSTORE_BASE64` | 4단계에서 만든 한 줄 텍스트 |
| `ANDROID_KEYSTORE_PASSWORD` | 저장소 비밀번호 |
| `ANDROID_KEY_ALIAS` | `photobooth` |
| `ANDROID_KEY_PASSWORD` | 키 비밀번호 |

---

## 6. APK 만들기

버전 태그를 올리면 GitHub가 APK를 만들어 **Releases**에 올립니다.

```bash
git tag v1.0.0
```

```bash
git push origin v1.0.0
```

저장소 **Actions** 탭에서 진행 상황을 볼 수 있습니다 (5~10분).
끝나면 **Releases**에 `photobooth-1.0.0.apk`가 붙어 있습니다.

업데이트할 때는 숫자만 올려서 같은 방법으로 태그를 올립니다 (`v1.0.1`).
설정값을 바꿨을 때(행사명 등)도 새 태그로 다시 빌드해야 앱에 반영됩니다.

---

## 7. 태블릿에 설치

1. 태블릿 브라우저로 GitHub **Releases** 페이지를 열고 `.apk` 파일을 받습니다
   - 비공개 저장소면 태블릿에서 GitHub에 로그인해야 받을 수 있습니다
2. 받은 파일을 열면 "출처를 알 수 없는 앱" 경고가 뜹니다 → **설정 → 이 출처 허용**
3. **설치** → 앱 실행 → 카메라 권한 **허용**
4. 첫 화면 오른쪽 위 모서리를 3초 누르고 PIN을 넣어 관리자 화면이 열리는지 확인합니다

업데이트는 새 APK를 같은 방법으로 받아 설치하면 덮어써집니다. 사진 대기열과 프레임은 유지됩니다.

---

## 8. 행사 전 점검 (매번)

- [ ] Supabase 대시보드에서 프로젝트가 **일시정지(Paused)** 상태가 아닌지 확인. 1주일 동안 아무도 안 쓰면 멈춥니다. 멈췄으면 **Restore** 누르고 몇 분 기다리기
- [ ] 태블릿 첫 화면 아래에 "아직 올라가지 않은 사진"이 남아 있지 않은지 확인
- [ ] 한 번 직접 찍어서 폰으로 QR → 사진·영상 저장까지 확인
- [ ] 태블릿 충전기 연결 (화면이 꺼지지 않게 설정되어 있어 배터리를 많이 씁니다)

---

## 9. 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 관리자 PIN에서 "PIN이 아직 설정되지 않았어요" | 2-3의 `set_admin_pin` 실행 |
| 관리자 PIN에서 "부스 키가 서버와 달라요" | GitHub Secret `BOOTH_KEY`와 Supabase 비밀값이 같은지, 바꿨다면 APK 다시 빌드 |
| QR은 뜨는데 폰에서 계속 "올리는 중이에요" | 태블릿 인터넷 연결, 첫 화면 아래 대기 건수 확인 |
| 폰에서 "연결이 불안정해요" | `web/config.js`의 주소와 키 확인, Supabase 일시정지 여부 |
| 하루가 지나도 사진이 안 지워짐 | 2-3의 `vault.create_secret` 두 줄 실행 여부. SQL Editor에서 `select * from cron.job_run_details order by start_time desc limit 5;`로 실행 기록 확인 |
| GitHub Actions 빌드가 "Missing repository setting" 오류 | 5단계 값 누락 |

---

## 개발용: 계정 없이 로컬에서 돌려보기

```bash
node dev/mock-server.ts
```

- 태블릿 앱: http://localhost:8787/app/ (관리자 PIN `1234`)
- 손님 페이지: 앱에서 찍은 뒤 QR 주소
- 실제 서버 함수 코드를 메모리 저장소로 실행합니다. `/__dev/offline?on=1`로 인터넷 끊김, `/__dev/advance?hours=25`로 시간 경과를 흉내 낼 수 있습니다

테스트:

```bash
node --test "supabase/tests/*.test.ts"
```

```bash
node --test "app/tests/*.test.mjs"
```
