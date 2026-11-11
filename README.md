# Herdr-Hansol

Herdr-Hansol은 [Herdr App](https://herdr.dev)의 코딩 에이전트 현황을 한눈에 볼 수 있도록 만든 한솔용 픽셀 오피스입니다. [Trellis의 Hakoniwa](https://github.com/trellis-grow-org/herdr-hakoniwa)를 기반으로 화면을 한글화하고 한솔 로고와 어두운 테마를 적용했습니다.

## 주요 기능

- Claude Code, Codex 등 실행 중인 에이전트를 작업공간별 오피스에 표시합니다.
- 작업 중, 승인 대기, 작업 보고, 대기 중 상태를 상단에서 확인합니다.
- 에이전트를 선택하면 실제 터미널 팝업을 열고 작업공간과 상태를 표시합니다.
- 하단의 **에이전트 상세**에서 대화와 도구 실행 내역을 확인합니다.
- Codex 대화는 화면의 요청과 기록이 하나의 세션에만 일치할 때 연결합니다. 확인할 수 없으면 터미널 화면을 표시합니다.

## 설치

Herdr App과 herdr-core가 설치되어 있어야 합니다. Python 3.10 이상과 `numpy`, `Pillow`도 필요합니다.

Herdr App의 에이전트에 다음과 같이 요청합니다.

```text
Read ~/.config/herdr-app/AGENTS.md, then add this layout: https://github.com/evelynn/Herdr-Hansol/tree/main/hakoniwa
```

설치 후 레이아웃을 선택합니다.

```powershell
python -m pip install numpy pillow
herdr-app check "$env:USERPROFILE\.config\herdr-app\mods\hakoniwa"
herdr-app do layout.switch --name hakoniwa
```

처음 실행할 때는 오피스 이미지를 생성하므로 화면이 나타나기까지 시간이 걸릴 수 있습니다.

## 설정

`hakoniwa/mods/hakoniwa/config.example.json`을 참고해 설치된 모드 폴더에 `config.json`을 만들면 작업공간, 날씨, 색상과 에이전트 실행 설정을 변경할 수 있습니다. 기본 설정으로도 사용할 수 있습니다.

```powershell
herdr-app do hakoniwa.demo
```

위 명령은 데모 에이전트를 켜거나 끕니다. 화면 구성과 동작 설명은 [hakoniwa/RECIPE.md](hakoniwa/RECIPE.md)에 있습니다.

## 원본과 라이선스

이 프로젝트는 [Trellis](https://trellis-grow.com/)가 만든 [Hakoniwa](https://github.com/trellis-grow-org/herdr-hakoniwa)의 fork입니다. 원본에 한솔용 화면과 한국어 표시를 적용했습니다.

[MIT 라이선스](LICENSE)를 따릅니다. 원본 픽셀 아트도 같은 라이선스가 적용됩니다.
