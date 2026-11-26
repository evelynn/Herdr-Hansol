# 꽃마을 (guild-meadow) 공간 설계 — v2 (2026-11-26)

v2 방향(사용자 지시 2026-11-24): 작업 구역이 한눈에 구별되게 구역마다 마당 있는 집을 두고, 분수 광장을 가운데 둔다.
대기·완료 보고 때도 모두 자기 자리를 지킨다. 이동 방식은 마을회관(guild-dark)과 같다(자리 고정 + 광장 산책 지점).
v1(상태마다 게시판·우체통·분수로 이동하는 방식, `l86: false`)은 v2로 대체했다.

플래너는 전용 `py/hansol-meadow.py` 1개다. 공용 부품(그림 저장·자르기·깊이 정렬·사람 그림·조명·자리 배정)은
`hansol-guild.py`·`hansol_guild_sprites.py` 것을 모듈로 불러 쓴다. 그림 시트는 v1 것을 그대로 쓴다.

## 1. 배치

| 위치 | 내용 |
| --- | --- |
| 뒤쪽 모서리 (gx, gy < 16) | 마을회관(종탑, 시간판), 게시판, 우체통 |
| 오른쪽 뒷변 (gy < 16) | 작업 구역의 짝수 번째(0, 2, 4…) 마당이 차례로 |
| 왼쪽 뒷변 (gx < 16) | 작업 구역의 홀수 번째(1, 3, 5…) 마당이 차례로 |
| 마당 사이·뒤 빈 땅 | 나무와 덤불 |
| 앞쪽 나머지 | 분수 광장(돌바닥). 분수 6×6, 가로등 4개, 벤치 2개, 우물, 꽃수레, 화분, 상자·통 |
| 앞쪽 두 변 | 낮은 울타리와 꽃밭이 번갈아 놓임. 오른쪽 끝에 덤불 |
| 입구 | 왼쪽 변 앞쪽 끝. 입구에서 분수까지 흙길 |

- 구역 순서는 작업 공간 이름 순이다.
- 첫 마당은 뒤쪽 모서리에서 2칸 떨어지고, 마당과 마당 사이도 2칸(`YGAP`)이다. 그래서 어느 두 마당도 2칸 이상 떨어진다.
- 광장이 큰 경우(광장 가로 + 세로 ≥ 70칸, 4구역 이상) 사분면마다 작은 정원(꽃밭, 벤치, 화분 2개, 가로등)을 더한다.
  분수에서 8칸 안쪽인 사분면은 건너뛴다. 6구역(20명)에서 넓은 돌바닥만 남는 문제 대응(2026-11-26 화면 확인 후 추가).

## 2. 작업 구역(마당) 하나

| 요소 | 내용 |
| --- | --- |
| 집 | 오두막 1채, 지붕을 구역 색으로 칠함(`roof_recolor`, 벽은 원래 색 유지) |
| 마당 | 울타리로 둘러쌈. 안쪽 바닥을 구역 색으로 옅게 칠함(`tint_yards`) |
| 책상 | 3×2 칸 테이블 + 앞쪽 의자 자리. 자리는 테이블 앞 가운데 `(tx + 1, ty + 2)` |
| 문 | 광장 쪽 울타리 가운데 2칸을 비움. 옆에 이름판과 가로등 |
| 크기 | 필요한 자리 수에 맞춰 늘어남(오른쪽 마당은 가로, 왼쪽 마당은 세로) |

## 3. 상태 → 위치

| 상태 | 위치 |
| --- | --- |
| 작업 중, 승인 대기, 작업 보고, 대기 | 모두 자기 책상 자리(`l86: true`) |
| 산책(마을회관과 같은 방식) | 광장의 산책 지점: 분수 앞, 벤치 앞, 우물 앞, 정원 벤치 앞 |

## 4. 판정 기준 (테스트)

| 번호 | 기준 | 테스트 |
| --- | --- | --- |
| ① | `l86 = true`, 모두 자기 자리 | `test_contract`, `test_everyone_keeps_their_seat` |
| ② | 구역끼리 2칸 이상 떨어짐, 구역마다 집·이름판·울타리·색 | `test_yards`, `test_a_yard_per_workspace` |
| ③ | 사람이 가려지는 면적 ≤ 25%, 자리는 자기 테이블 앞 가운데 | `test_nobody_hidden`, `test_seat_at_its_table` |
| ④ | 1·8·20명, 1~6구역에서 자리 부족 없음, 입구에서 모든 자리에 도달 | `Sizes.test_one_to_twenty_people`, `test_reachable_from_the_gate` |
| ⑤ | 마을회관 장면 변화 없음 | `GuildUnchanged.test_guild_scene_id` |
| 그 밖 | 결정성, 물건 겹침 없음, 큰 광장 정원, 가로등 밤 조명, 시계 | `test_same_input_same_plan` 등 |

- 부품 단위 시험: `hansol/tests/test_meadow_parts.py`(지붕 칠, 배치, 울타리, 바닥 칠), `hansol/tests/smoke_meadow.py <함수>`(함수 하나를 실제 plan 안에서 시험).
- 전체 실행: `python -X utf8 -m unittest hansol/tests/test_meadow_parts.py hansol/tests/test_meadow_plaza.py` (약 3분 20초, 27개).
- 사람 눈 확인: `hansol-meadow.py --demo --agents <JSON> --preview <PNG>` 미리보기 + 실제 Herdr 화면(낮·밤).

## 5. 구현 구조 (`hansol-meadow.py`)

| 함수 | 역할 |
| --- | --- |
| `site` | 마당 위치와 전체 크기 계산 |
| `roof_recolor`, `tint_yards` | 지붕 칠, 마당 바닥 칠 |
| `fence_run`, `build_yard` | 울타리, 마당 하나(집·책상·자리·문·이름판·가로등) |
| `build_corner`, `build_plaza`, `build_groves`, `build_edges` | 뒤쪽 모서리, 분수 광장, 큰 광장 정원, 가장자리 |
| `lay_floor` | 바닥 그림(풀밭·돌바닥·흙길) |
| `plan` | 위 함수를 묶어 장면 JSON 생성 |
| `render_preview` | 앱 없이 보는 미리보기 PNG |

- 각 함수의 docstring이 명세다. 함수 본문은 Atlas가 docstring대로 구현했고, Claude가 테스트·diff·화면으로 확인했다.
- CLI는 v1과 같다: `--agents --box [--demo] [--config] [--check] [--preview] [--grid]`, 표준출력 마지막 줄에 JSON 1개.
