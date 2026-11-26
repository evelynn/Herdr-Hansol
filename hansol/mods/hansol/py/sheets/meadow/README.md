# 꽃마을 광장 — 그림 시트 제작 지침

Hansol의 세 번째 배경 "꽃마을 광장"(지붕 없는 마을 광장, 동화책 삽화풍)에 쓰는 그림 시트 제작 지침이다.
공간 설계는 같은 폴더의 `DESIGN.md`, 시트 목록과 조각 순서의 원본은 `sheets.json`이며, 이 문서와 다르면 `sheets.json`을 따른다.
장면은 전용 플래너 `hansol/mods/hansol/py/hansol-meadow.py`가 만든다.

## 시트 구성
- 배경 시트 6장(`m1`~`m6`)은 이 테마 전용이다. 마을회관 그림으로 대체하지 않는다.
- 캐릭터 시트(`c-<직업>-poses/walk/work`)가 이 폴더에 아직 없으면 guild-dark 캐릭터를 그대로 쓴다. 화풍이 달라 보이므로 12직업 모두 이 폴더에 그리는 것이 목표다.
- 화면에 쓰려면 기본 14장(배경 6장 + 기본 4직업의 포즈·걷기 8장)이 모두 `ok`여야 한다.

## 직접 그리기 (사람이 이미지 생성 모델로)
경로는 모두 저장소 루트 기준이다.
1. 기준 그림을 첨부할 수 있는 이미지 생성 모델을 연다. 시트 1장 = 대화 1개로 한다.
2. 기준 그림을 첨부한다.
   - 배경 시트(`m1`~`m6`): `hansol/mods/hansol/py/sheets/20261102_175916_00.png`, `hansol/mods/hansol/py/sheets/20261103_150950.png`(배율·시점만 참고), `m1` 다음부터는 `m1-ground.png`(색 참고)
   - 캐릭터 포즈·작업 시트: `hansol/mods/hansol/py/sheets/20261102_180223_02.png` + 이 폴더의 `c-wizard-poses.png`(화풍 참고, 다른 인물)
   - 캐릭터 걷기 시트: `hansol/mods/hansol/py/sheets/20261103_150235_00.png` + 같은 직업의 포즈 시트(같은 인물로 그리기 위해)
3. 아래 "공통 화풍 프롬프트" 블록 전체 + 해당 시트의 프롬프트 블록을 이어 붙여 입력한다. 캐릭터는 "직업 캐릭터 공통" 블록과 직업별 인물 설명도 붙인다.
4. 결과 PNG를 `sheets.json`의 파일명 그대로 `hansol/mods/hansol/py/sheets/meadow/`에 저장한 뒤 `python hansol/mods/hansol/py/sheet_clean.py <파일>`로 가장자리를 정리한다.
5. 검사: `python hansol/mods/hansol/py/hansol-meadow.py --check` — 방금 넣은 시트의 `ok`가 `true`인지 본다. `false`면 `problem` 내용을 영어로 프롬프트 끝에 덧붙여 다시 생성한다(최대 3회).
6. 전체 모습 확인: `python hansol/mods/hansol/py/hansol-meadow.py --preview meadow-preview.png`
7. 권장 순서: `m1` → `m2`~`m6` → 캐릭터.

## 모든 시트 공통 규칙
- **배경:** 완전 투명. 투명이 불가능하면 단색 순백(#FFFFFF) 한 가지.
- **배치:** 각 조각은 따로 떨어진 스프라이트 1개. 조각끼리, 그리고 이미지 가장자리와 **40px 이상** 띄운다. 그림자·빛 번짐·파편이 다른 조각에 닿거나 따로 떨어져 있으면 안 된다.
- **순서:** `sheets.json`의 `rows`대로. 윗줄부터, 각 줄은 왼쪽에서 오른쪽으로, 같은 줄 조각은 같은 높이에. 줄 사이는 충분히 띄운다.
- **금지:** 바닥면·배경 풍경·글자·라벨·테두리·격자선·워터마크.
- **크기:** 1024×1024 이상(가로로 넓은 시트는 1536×1024 가능).
- **`ref_tile`:** 배율 측정용 평범한 조약돌 바닥 타일 1장. 마름모 윗면 너비 = 이미지 너비의 약 1/6, 높이 = 너비의 1/2. 같은 시트의 다른 조각은 모두 이 타일과 같은 배율로 그린다.
- **사람 크기:** 서 있는 사람의 키 ≈ 바닥 타일 너비. 캐릭터는 약 3등신, 배경과 같은 손그림 화풍.
- **방향 용어:**
  - `_l`: 광장의 왼쪽 뒷변(위쪽 꼭짓점에서 왼쪽 아래로 내려가는 변)과 나란한 것
  - `_r`: 광장의 오른쪽 뒷변(위쪽 꼭짓점에서 오른쪽 아래로 내려가는 변)과 나란한 것
  - `_f`: 인물이 왼쪽 아래(보는 사람 쪽)를 향함
  - `_b`: 인물이 오른쪽 위(등을 보임)를 향함
- **상표:** 특정 게임·작품의 로고, 고유 이름, 고유 캐릭터·몬스터는 쓰지 않는다.
- **마젠타 키 색:** 노점 차양과 캐릭터 옷만 `#D02FC0`(앱이 공간·사람마다 색을 바꿈). 그 밖에는 마젠타를 쓰지 않는다.

### 공통 화풍 프롬프트 (모든 시트 앞에 붙임)
```
Isometric game sprite sheet. 2:1 dimetric projection (floor tiles are diamonds twice as wide as tall).
Hand-painted storybook illustration style: soft painterly brush textures like watercolour and gouache, gentle
low contrast, soft diffuse daylight, calm and cozy European medieval village mood. Clean readable silhouettes with
a thin dark-brown outline. Muted warm earthy palette: sandstone beige, weathered timber brown, moss green, faded
terracotta, dusty slate blue. NOT neon, NOT oversaturated, NOT candy pastel, no busy high-contrast detail.
Match the scale and the camera angle of the attached reference sheet (not its colours or its pixel style).
Setting: the open-air market square of a small European-style fantasy village by day: sandstone cobbles, soft
grass edges with a few wildflowers, timber-framed cottages with terracotta and slate roofs, wooden market stalls,
a stone fountain, old linden trees. Flowers are small accents only.
Every object must stay clearly readable. Light comes from the upper left.
Each object is a separate isolated sprite. No ground plane, no scenery, no text, no labels, no frame, no grid lines,
no cast shadows outside the object. Fully transparent background (if impossible: one flat pure white background).
Leave at least 40 px of empty background between any two sprites and around the image edges; nothing may touch.
Arrange the sprites in exactly the rows listed below, top row first; sprites in a row side by side at the same
height, in the listed order from left to right.
No logos, names, symbols, characters or creatures from any existing game or franchise.
Do not use magenta anywhere unless the sheet prompt asks for it.
```

## 배경 시트 프롬프트 (공통 프롬프트 뒤에 붙임)

### m1-ground.png — 광장 바닥 (6조각: 3 / 3)
```
Six floor tiles, each one isometric diamond tile with a thin visible edge thickness, all the same size
(tile width about 1/6 of the image width).
Row 1: cobble_a, cobble_b, cobble_c = three variations of the SAME warm sandstone cobblestone paving (the same
colour and brightness in all three, only the stone pattern differs, so a large square looks calm and even; they
must tile seamlessly).
Row 2: grass_a = soft muted meadow grass with a few tiny white and yellow wildflowers; grass_b = the same grass
with a few clover patches (the same green and brightness as grass_a); path = packed light-brown earth path with a
few small pebbles.
All six tiles have the same calm brightness. The green is muted and soft, never saturated.
No ground plane, no text, no labels, no borders, no grid lines, no watermark.
```

### m2-houses.png — 뒷변 오두막과 회관 (6조각: 3 / 3)
```
The buildings that line the two back edges of the open village square, seen from the square (we see their fronts
and their roofs). Each building is 4 floor tiles long along its edge and about 2.6 floor-tile widths tall to the
roof ridge. Each building stands on its own; nothing behind it.
Row 1: ref_tile = one plain sandstone cobblestone floor tile (scale reference);
house_l = a two-storey timber-framed cottage (cream plaster, dark timber beams, faded terracotta roof, a wooden
front door, two shuttered windows, one flower box) on the LEFT back edge: its front runs from upper right down to
lower left and looks down-right;
house_r = a different cottage (sandstone ground floor, timber upper floor, dark slate roof, a round shop window)
on the RIGHT back edge: its front runs from upper left down to lower right and looks down-left.
Row 2: house_l2 = another cottage for the left edge (narrow and tall, a small wooden balcony, ivy on one corner);
house_r2 = another cottage for the right edge (a bakery with a dusty-blue cloth awning over its door and a
bread basket by the door);
hall = the village hall for the RIGHT back edge, facing down-left: a wider sandstone and timber building with a
small square bell tower holding a bronze bell, a wide arched double door and two stone steps.
No ground plane, no text, no labels, no borders, no grid lines, no watermark.
```

### m3-stall.png — 노점·테이블 (7조각: 3 / 4)
```
Row 1: ref_tile = one plain sandstone cobblestone floor tile;
stall_l = an open wooden market stall, 3 floor tiles long with its long side parallel to the LEFT back edge, its
counter looking down-right: a timber frame, a counter with baskets of apples, bread and herbs, and a sloping cloth
awning on top painted in bright magenta #D02FC0 (shaded only with darker and lighter magenta);
stall_r = the same stall with its long side parallel to the RIGHT back edge, its counter looking down-left.
Row 2: table_l = a rustic wooden trestle table, footprint 2 x 1 floor tiles, long side parallel to the LEFT back
edge, with a small jar of flowers and a few papers, no chairs;
table_r = the same table with its long side parallel to the RIGHT back edge;
stool = a tree-stump stool (1 tile), the same stump the seated characters sit on;
sign = a flat, front-facing (not isometric) empty pale-wood sign board on one short wooden post, the board about
2.5 times as wide as tall, completely blank (no text, no symbols: the app writes the stall's name on it).
Only the two awnings are magenta; no other magenta anywhere.
No ground plane, no text, no labels, no borders, no grid lines, no watermark.
```

### m4-landmarks.png — 광장 시설 (6조각: 3 / 3)
```
Row 1: ref_tile = one plain sandstone cobblestone floor tile;
fountain = a round two-tier sandstone fountain with calm clear blue-green water and a small stone fish spouting on
top, footprint 3 x 3 floor tiles;
notice_board = the village chief's notice board: a free-standing wooden board with a small shingle roof on two
posts and pinned paper notices (no readable text), 2 tiles wide, its face looking down-left (parallel to the RIGHT
back edge).
Row 2: post_box = a mail post: a painted dark-green wooden letter box on a post with a little bird house on top
(1 tile);
gate_arch = the square's entrance in the LEFT back edge: two sandstone pillars with a wooden beam on top, covered
with climbing roses and wisteria, spanning a passage 2 tiles wide, the arch's face looking down-right (parallel to
the left back edge), open (no doors);
plaque = a flat, front-facing (not isometric) empty pale-wood sign board with a white frame and two short chains on
top, about 2.5 times as wide as tall, completely blank (the app writes the clock over it).
No ground plane, no text, no labels, no borders, no grid lines, no watermark.
```

### m5-nature.png — 나무·꽃밭·울타리·가로등 (7조각: 4 / 3)
```
Row 1: ref_tile = one plain sandstone cobblestone floor tile;
tree = a big old linden tree: the trunk on a 1-tile footprint, a round soft canopy about 3 tiles wide, the whole
tree about 3.5 floor-tile widths tall;
flower_bed = a low raised flower bed with a stone border, 2 x 1 tiles, long side parallel to the LEFT back edge,
soft pink, white and lavender flowers;
bush = a round trimmed green hedge bush (1 tile, knee to waist high).
Row 2: fence_l = a low weathered white picket fence, 2 tiles long, parallel to the LEFT back edge, knee high;
fence_r = the same fence parallel to the RIGHT back edge;
lamp = a wrought-iron street lamp post with one glass lantern on top (1 tile, about 1.8 times as tall as a person),
the lantern glass pale and unlit.
No ground plane, no text, no labels, no borders, no grid lines, no watermark.
```

### m6-decor.png — 소품 (8조각: 4 / 4)
```
Row 1: ref_tile = one plain sandstone cobblestone floor tile;
flower_cart = a wooden hand cart full of flower pots, 2 x 1 tiles, long side parallel to the LEFT back edge;
crates = two stacked wooden market crates with apples (1 tile);
barrel = a wooden rain barrel (1 tile).
Row 2: well = a small round stone well with a little wooden roof and a bucket (1 tile);
planter = a big terracotta planter with a small olive tree (1 tile);
bench_l = a plain wooden park bench, 2 x 1 tiles, parallel to the LEFT back edge, its seat looking down-right;
bench_r = the same bench parallel to the RIGHT back edge, its seat looking down-left.
No ground plane, no text, no labels, no borders, no grid lines, no watermark.
```

## 캐릭터 시트 프롬프트

### 직업 캐릭터 공통 (포즈·걷기 시트 8장)
```
One adventurer character, the same person in every sprite of the sheet, same scale (standing height about equal to
one floor tile width), storybook proportions, about 3 heads tall, gentle friendly faces, the same painterly style as the floor and walls.
KEY COLOUR RULE: the character's main cloth (robe / tabard / cloak / vestment) is painted in bright magenta #D02FC0,
shaded only with darker and lighter magenta. No other magenta anywhere in the image.
Leather, metal, skin and hair keep normal natural colours.
No ground plane, no text, no labels, no borders, no grid lines, no watermark.
```

직업별 인물 (포즈·걷기 시트 공통):
- **wizard:** 젊은 성인 남성 마법사. 소매가 넓은 긴 로브(마젠타), 뾰족 모자(연한 갈색), 서 있거나 걸을 때는 나무 지팡이를 든다(앉은 포즈에는 지팡이 없음).
- **fighter:** 성인 여성 전사. 사슬 갑옷과 강철 어깨 보호대, 갑옷 위 긴 서코트(마젠타), 허리에 장검, 투구 없음(얼굴 보임).
- **rogue:** 성인 남성 도적. 가죽 갑옷, 후드 망토(마젠타, 후드는 내려 얼굴·머리 보임), 허리에 단검 두 자루.
- **cleric:** 성인 여성 성직자. 긴 제의(마젠타)와 영대, 새로 디자인한 웃는 태양 성표 목걸이, 허리에 철퇴.

### c-<직업>-poses.png — 포즈 (8조각: 3 / 2 / 3)
```
Row 1: stand_f = standing still, facing down-left (3/4 front view, like the reference standing pose);
stand_b = standing still, facing up-right (back to the viewer);
wave_f = standing facing down-left with one hand raised high, waving happily.
Row 2: write = seated on the wooden stump stool (the stool is part of this sprite and matches the stool sprite),
back to the viewer, facing up-right, leaning forward writing with a quill as if at a table (do NOT draw the table),
like the reference typing pose;
read = seated on the same stool, back to the viewer facing up-right, holding an open picture book up and reading.
Row 3: give_f = standing facing down-left, holding out a rolled paper scroll tied with a little ribbon with both
hands (handing in a report);
mug_f = standing facing down-left holding a wooden mug of lemonade; mug_b = standing facing up-right holding the mug.
No ground plane, no text, no labels, no borders, no grid lines, no watermark.
```

### c-<직업>-walk.png — 걷기 (16조각: 4 / 4 / 4 / 4)
```
An 8-frame walk cycle in two directions, like the reference walk sheet, but laid out in four rows of four.
Feet always at the same baseline within a row; the same scale in every frame.
Row 1: f1 f2 f3 f4 = walking toward down-left (facing the viewer), frames 1-4 (left leg forward phase).
Row 2: f5 f6 f7 f8 = the same direction, frames 5-8 (right leg forward phase).
Row 3: b1 b2 b3 b4 = walking toward up-right (back to the viewer), frames 1-4.
Row 4: b5 b6 b7 b8 = the same direction, frames 5-8.
No ground plane, no text, no labels, no borders, no grid lines, no watermark.
```

### 새 직업 8종 (포즈·걷기 시트 공통 인물 설명, 직업 캐릭터 공통 프롬프트 뒤에 붙임)
- **barbarian:** 성인 남성 바바리안. 털 장식 가죽 갑옷, 맨팔, 허리와 어깨에 두른 큰 천(마젠타), 등에 큰 양날 도끼.
- **bard:** 성인 여성 음유시인. 더블릿과 짧은 망토(마젠타), 깃털 달린 챙 모자(연한 갈색), 등에 류트.
- **druid:** 성인 남성 드루이드. 잎 무늬 가장자리가 있는 긴 로브(마젠타), 후드는 내림, 서 있거나 걸을 때 잎이 달린 나무 지팡이(앉은 포즈에는 없음).
- **monk:** 성인 여성 수도승. 여밈 무술복(마젠타)과 천 허리띠, 머리는 올려 묶음, 무기 없음, 짚신.
- **paladin:** 성인 남성 팔라딘. 강철 판금 갑옷, 갑옷 위 서코트(마젠타)에 새로 디자인한 금색 태양 장미 문양, 허리에 장검, 투구 없음.
- **ranger:** 성인 여성 레인저. 가죽 갑옷, 후드 망토(마젠타, 후드는 내림), 등에 활과 화살통.
- **sorcerer:** 성인 남성 소서러. 높은 깃의 몸에 맞는 긴 코트(마젠타), 팔의 푸른 비전 문신, 목에 작은 수정 구슬 펜던트, 무기 없음.
- **warlock:** 성인 여성 워락. 긴 로브(마젠타)와 검은 가죽 코르셋, 초록색 가장자리 장식, 허리에 쇠사슬로 묶인 작은 마법서, 후드는 내림.

포즈·걷기 시트 프롬프트는 위의 `c-<직업>-poses.png`, `c-<직업>-walk.png`와 같다.

### c-<직업>-work.png — 필사 동작 3프레임 (3조각: 3)
같은 직업의 `c-<직업>-poses.png`를 참고 이미지로 함께 넣는다. 인물·걸상·배율이 그 시트의 `write` 조각과 같아야 한다.
```
Three animation frames of the same seated writing pose as the "write" sprite of the attached poses sheet
(the same person, the same stump stool, the same scale; seated, back to the viewer, facing up-right, writing with a
quill as if at a table; do NOT draw the table). Only the writing arm, hand and quill move; the head may tilt very
slightly. The body, the stool and the feet stay at exactly the same place in all three frames.
Row 1: write_a = the quill touching the page, hand to the left; write_b = the quill lifted a little, hand in the
middle; write_c = the quill touching the page, hand to the right.
No ground plane, no text, no labels, no borders, no grid lines, no watermark.
```

## 검사 기준 (`--check`)
- 시트의 조각 수와 줄별 개수가 `sheets.json`과 정확히 같으면 `ok: true`.
- `problem`에 "pieces touching"이 나오면 조각 사이를 더 띄우거나 떨어진 파편을 없앤다.
- 기본 14장이 모두 `ok`가 아니면 꽃마을 화면 대신 "그림 준비 안 됨 (n/14)" 안내가 나온다. 추가 시트(`required: false`)는 `extra`에 따로 센다.
