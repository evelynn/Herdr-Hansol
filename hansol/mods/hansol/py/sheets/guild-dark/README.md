# 모험가 길드 회관 (다크) — 그림 시트 제작 지침

Hansol의 두 번째 레이아웃 "모험가 길드 회관 (다크)"에 쓰는 그림 시트 14장의 제작 지침이다.
시트 목록과 조각 순서의 원본은 같은 폴더의 `sheets.json`이며, 이 문서와 다르면 `sheets.json`을 따른다.

## 작업 순서 (이미지 생성 담당)
1. `sheets.json`과 이 문서를 읽는다.
2. 화풍·비율 기준 그림을 직접 열어 본다(저장소 루트 `D:\VBOX\Herdr-Hansol` 기준 경로).
   - 사람: `hansol/mods/hansol/py/sheets/20261102_180223_02.png` (앉아서 일하기, 서기, 걷기)
   - 걷기 8프레임: `hansol/mods/hansol/py/sheets/20261103_150235_00.png`
   - 방 조각(바닥·벽·문): `hansol/mods/hansol/py/sheets/20261102_175916_00.png`
   - 가구: `hansol/mods/hansol/py/sheets/20261103_150950.png`
3. 시트 하나당 이미지 1장을 생성해 이 폴더(`hansol/mods/hansol/py/sheets/guild-dark/`)에 `sheets.json`의 파일명으로 PNG 저장.
4. 저장할 때마다 저장소 루트에서 검사 실행:
   `python hansol/mods/hansol/py/hansol-guild.py --check`
   해당 시트의 `ok`가 `false`이면 `problem`을 읽고 다시 생성(시트당 최대 3회). 3회 실패하면 다음 시트로 넘어가고 마지막에 보고.
5. 한 직업의 포즈 시트와 걷기 시트는 같은 인물이어야 한다. 걷기 시트를 만들 때 포즈 시트를 참고 이미지로 함께 넣는다.
6. 코드 파일은 수정하지 않는다. git 커밋하지 않는다.
7. 끝나면 시트별 결과(파일명, ok, 다시 만든 횟수, 남은 문제)를 표로 보고.

## 모든 시트 공통 규칙
- **배경:** 완전 투명. 투명이 불가능하면 단색 순백(#FFFFFF) 한 가지.
- **배치:** 각 조각은 따로 떨어진 스프라이트 1개. 조각끼리, 그리고 이미지 가장자리와 **40px 이상** 띄운다. 그림자·빛 번짐·파편이 다른 조각에 닿거나 따로 떨어져 있으면 안 된다.
- **순서:** `sheets.json`의 `rows`대로. 윗줄부터, 각 줄은 왼쪽에서 오른쪽으로, 같은 줄 조각은 같은 높이에. 줄 사이는 충분히 띄운다.
- **금지:** 바닥면·배경 풍경·글자·라벨·테두리·격자선·워터마크.
- **크기:** 1024×1024 이상(가로로 넓은 시트는 1536×1024 가능).
- **`ref_tile`:** 배율 측정용 평범한 판석 바닥 타일 1장. 마름모 윗면 너비 = 이미지 너비의 약 1/6, 높이 = 너비의 1/2. 같은 시트의 다른 조각은 모두 이 타일과 같은 배율로 그린다.
- **사람 크기:** 서 있는 사람의 키 ≈ 바닥 타일 너비. 기준 그림과 같은 비율.
- **방향 용어:**
  - `_l`: 방의 왼쪽 뒷벽(위쪽 꼭짓점에서 왼쪽 아래로 내려가는 변)과 나란한 것
  - `_r`: 방의 오른쪽 뒷벽(위쪽 꼭짓점에서 오른쪽 아래로 내려가는 변)과 나란한 것
  - `_f`: 인물이 왼쪽 아래(보는 사람 쪽)를 향함
  - `_b`: 인물이 오른쪽 위(등을 보임)를 향함
- **상표:** 정통 테이블탑 RPG풍 일반 판타지만 사용. 특정 게임·작품의 로고, 고유 이름, 고유 몬스터, 문장은 쓰지 않는다. 문장은 새로 디자인.

### 공통 화풍 프롬프트 (모든 시트 앞에 붙임)
```
Isometric pixel-art game sprite sheet. 2:1 dimetric projection (floor tiles are diamonds twice as wide as tall).
Crisp pixel art with dark 1-pixel outlines, the same cozy chunky style and proportions as the attached reference sheet.
Setting: a medieval high-fantasy adventurers' guild hall at night, classic tabletop-RPG fantasy, dark mood:
weathered dark grey stone, dark oak wood, black iron fittings, warm orange torch and candle light, deep blue-violet shadows.
Every object must stay clearly readable. Light comes from the upper left.
Each object is a separate isolated sprite. No ground plane, no scenery, no text, no labels, no frame, no grid lines,
no cast shadows outside the object. Fully transparent background (if impossible: one flat pure white background).
Leave at least 40 px of empty background between any two sprites and around the image edges; nothing may touch.
Arrange the sprites in exactly the rows listed below, top row first; sprites in a row side by side at the same height,
in the listed order from left to right.
No logos, names, symbols or creatures from any existing game or franchise.
```

## 시트별 프롬프트 (공통 프롬프트 뒤에 붙임)

### g1-floor.png — 바닥 (6조각: 3 / 3)
```
Six floor tiles, each one isometric diamond tile with a thin visible edge thickness, all the same size
(tile width about 1/6 of the image width).
Row 1: flag_a, flag_b, flag_c = three variations of dark grey flagstone floor (different stone patterns, they must tile seamlessly).
Row 2: flag_worn = cracked worn flagstone with moss in the joints; plank = dark oak plank floor;
hearthstone = warm reddish-brown hearth stone tile with faint soot.
```

### g2-walls.png — 벽 (8조각: 4 / 2 / 3)
```
Interior stone walls of the hall, seen from inside the room (we see the inner face and the top of the wall).
Wall height about 1.6 x the floor tile width. Each wall segment is 2 floor tiles long.
Row 1: ref_tile = one plain flagstone floor tile (scale reference);
wall_l = a plain dark stone wall segment on the LEFT back edge of the room (runs from upper right down to lower left, inner face looks down-right);
wall_r = the same wall on the RIGHT back edge (runs from upper left down to lower right, inner face looks down-left);
corner = the back corner post where the two walls meet, same height.
Row 2: window_l = wall_l with a tall pointed-arch stained-glass window (deep blue, violet and amber glass, moonlight shining through);
window_r = the same window in wall_r.
Row 3: torch_l = wall_l with a lit iron torch sconce; torch_r = wall_r with a lit iron torch sconce;
pillar = a free-standing round stone pillar on a 1-tile square base, as tall as the walls.
```

### g3-door.png — 문 (4조각: 2 / 2)
```
The guild hall's main entrance in the LEFT back wall: a wall section 2 floor tiles long and as tall as the walls,
with a large arched oak double door with black iron bands. All three door pieces have exactly the same outline size.
Row 1: ref_tile = one plain flagstone floor tile; door_closed = the door closed.
Row 2: door_half = both door leaves half open (about 45 degrees, opening into the room);
door_open = both leaves fully open against the wall, a dark passage visible.
```

### g4-tables.png — 탁자 (7조각: 3 / 2 / 2)
```
Row 1: ref_tile = one plain flagstone floor tile;
table_l = a sturdy dark-oak writing table, footprint 2x1 floor tiles, long side parallel to the LEFT back wall,
with a lit candle, an open ledger/spellbook, a quill and an ink pot on it, no chair;
table_r = the same table with its long side parallel to the RIGHT back wall.
Row 2: bench_l = a plain wooden bench, footprint 2x1, parallel to the left back wall; bench_r = the same bench parallel to the right back wall.
Row 3: round_table = a round tavern table (1 tile) with two wooden ale mugs and a candle;
stool = an empty three-legged wooden stool (1 tile), the same stool the seated characters use.
```

### g5-hall.png — 회관 시설 (9조각: 3 / 3 / 3)
```
Row 1: ref_tile = one plain flagstone floor tile;
hearth = a large stone fireplace with a crackling fire, 3 tiles wide, its back against the RIGHT back wall (opening faces down-left);
quest_board = a wooden notice board full of pinned parchment quest notes with wax seals, mounted flat on the LEFT back wall, 2 tiles wide.
Row 2: keg = an ale keg on a wooden stand with a brass tap (1 tile); well = a small indoor stone well with a wooden bucket and rope (1 tile);
potion_shelf = a wall cabinet with glowing potion bottles (red, blue, green), 2 tiles, against the LEFT back wall.
Row 3: bookshelf = a tall bookshelf with old tomes and scrolls, 2 tiles, against the RIGHT back wall;
armchair = a high-backed dark leather armchair facing down-left; brazier = a standing iron brazier with glowing coals (1 tile).
```

### g6-deco.png — 장식 (9조각: 4 / 3 / 2)
```
Row 1: ref_tile = one plain flagstone floor tile;
banner_red, banner_blue, banner_green = tall cloth guild banners hanging from a short iron wall bracket,
each with a newly designed emblem (crossed sword and staff / a shield with a star / a stylized dragon head).
Row 2: weapon_rack = a wooden rack with two swords, a spear and a round shield (2 tiles, parallel to the left back wall);
barrel = a wooden barrel; crates = a stack of two wooden crates.
Row 3: candle_stand = a tall iron candelabra with three lit candles;
chandelier = a round iron wagon-wheel chandelier with lit candles, with only a short stub of chain on top.
```

### 직업 캐릭터 공통 (포즈·걷기 시트 8장)
```
One adventurer character, the same person in every sprite of the sheet, same scale (standing height about equal to
one floor tile width; same proportions as the attached reference people sheet).
KEY COLOUR RULE: the character's main cloth (robe / tabard / cloak / vestment) is painted in bright magenta #D02FC0,
shaded only with darker and lighter magenta. No other magenta anywhere in the image.
Leather, metal, skin and hair keep normal natural colours.
```

직업별 인물 (포즈·걷기 시트 공통):
- **wizard:** 젊은 성인 남성 마법사. 소매가 넓은 긴 로브(마젠타), 뾰족 모자(어두운 갈색), 서 있거나 걸을 때는 나무 지팡이를 든다(앉은 포즈에는 지팡이 없음).
- **fighter:** 성인 여성 전사. 사슬 갑옷과 강철 어깨 보호대, 갑옷 위 긴 서코트(마젠타), 허리에 장검, 투구 없음(얼굴 보임).
- **rogue:** 성인 남성 도적. 가죽 갑옷, 후드 망토(마젠타, 후드는 내려 얼굴·머리 보임), 허리에 단검 두 자루.
- **cleric:** 성인 여성 성직자. 긴 제의(마젠타)와 영대, 새로 디자인한 태양 원반 성표 목걸이, 허리에 철퇴.

### c-<직업>-poses.png — 포즈 (8조각: 3 / 2 / 3)
```
Row 1: stand_f = standing still, facing down-left (3/4 front view, like the reference standing pose);
stand_b = standing still, facing up-right (back to the viewer);
wave_f = standing facing down-left with one hand raised high (asking for attention).
Row 2: write = seated on the empty wooden stool (the stool is part of this sprite and matches the stool sprite),
back to the viewer, facing up-right, leaning forward writing with a quill as if at a table (do NOT draw the table),
like the reference typing pose;
read = seated on the same stool, back to the viewer facing up-right, holding an open book up and reading.
Row 3: give_f = standing facing down-left, holding out a rolled parchment scroll with both hands (handing in a report);
mug_f = standing facing down-left holding a wooden ale mug; mug_b = standing facing up-right holding the mug.
```

### c-<직업>-walk.png — 걷기 (16조각: 4 / 4 / 4 / 4)
```
An 8-frame walk cycle in two directions, like the reference walk sheet, but laid out in four rows of four.
Feet always at the same baseline within a row; the same scale in every frame.
Row 1: f1 f2 f3 f4 = walking toward down-left (facing the viewer), frames 1-4 (left leg forward phase).
Row 2: f5 f6 f7 f8 = the same direction, frames 5-8 (right leg forward phase).
Row 3: b1 b2 b3 b4 = walking toward up-right (back to the viewer), frames 1-4.
Row 4: b5 b6 b7 b8 = the same direction, frames 5-8.
```

## 추가 시트 (2차 29장 + 3·4차 각 1장, 모두 `required: false`)
화면은 기본 14장만으로 동작한다. 아래 시트는 `--check`에서 `ok: true`가 되는 순간부터 자동으로 쓰인다.
- 직업은 포즈·걷기 시트가 둘 다 `ok`일 때 배정 대상에 들어간다.
- 작업 그림 시트(`-work`)가 `ok`이면 앉아서 쓰는 모습이 움직이는 그림이 된다.

### 생성 순서
1. `g7-guild.png` (1장)
2. 기존 4직업 작업 그림: `c-wizard-work.png`, `c-fighter-work.png`, `c-rogue-work.png`, `c-cleric-work.png`
3. 새 8직업 포즈·걷기: barbarian, bard, druid, monk, paladin, ranger, sorcerer, warlock (직업마다 poses → walk 순서, 16장)
4. 새 8직업 작업 그림: `c-<직업>-work.png` (8장)

### g7-guild.png — 작업공간 깃발·시계판 (3조각: 3)
```
Row 1: ref_tile = one plain flagstone floor tile;
standard = a free-standing guild standard on the floor: a dark oak pole on a small iron tripod foot, a crossbar at the top,
and a long hanging cloth banner painted in bright magenta #D02FC0 (shaded only with darker and lighter magenta) with a
plain gold border and NO emblem; about 1.6 times as tall as a standing person, footprint one floor tile;
plaque = a flat, front-facing (not isometric) empty dark oak sign board with an iron frame and two short chains on top,
about 2.5 times as wide as tall, completely blank (no text, no symbols: the hall's clock is written over it by the app).
Only the standard's cloth is magenta; no other magenta anywhere.
```

### g8-outside.png — 창밖 풍경 4시간대 (4조각: 1 / 1 / 1 / 1, 3차 추가)
창 유리 칸에 비치는 바깥 풍경. 앱이 벽 기울기에 맞춰 비틀고 창마다 다른 구간을 잘라 쓴다.
```
Four wide landscape panoramas of the same place, one per row, each about 6 times as wide as tall, flat front view
(NOT isometric), no frame, no text: the view out of a medieval guild hall's windows - rolling green hills, a dark pine
forest in the middle distance, far blue mountains, a small stone castle with towers on a far hill on the left third,
a winding road. The same landscape and composition in all four; only the light and sky change.
Row 1: morning = sunrise, golden-pink sky, low sun on the left, light mist in the valley.
Row 2: day = clear bright blue sky with a few white clouds, sunlit green hills.
Row 3: evening = sunset, orange-violet sky, low sun on the right, warm rim light, long shadows.
Row 4: night = dark blue night sky with many small stars and a crescent moon, dark hills, a few warm lit windows in the castle.
Each panorama is one piece filling its full width (the sky is part of the piece, not background); 40 px empty between the rows.
```

### g10-decor.png — 빈 책상과 추가 소품 (12조각, 4차 추가)
빈 자리 책상과, 회관이 넓어질 때 벽가·가장자리에 두는 소품. g4·g5 와 같은 배율·화풍·빛 방향, 3행 × 4칸, 칸 사이 48px 이상 투명 간격.
```
Row 1: ref_tile = one plain flagstone floor tile;
table_empty = the SAME writing table as g4's table_r (same size, same angle, long side along the right back wall), but unused:
  its candle unlit and short (no flame, no glow), the book closed, no quill, a little dust; no chair;
chest = a small iron-bound wooden chest, lid closed (1 tile); sacks = two or three tied grain sacks leaning together (1 tile).
Row 2: plant = a fern in a clay pot (1 tile, knee high); globe_table = a small round side table with a brass globe (1 tile);
armor_stand = a plate armour on a wooden stand (1 tile, as tall as a person);
book_pile = a pile of old books and a rolled scroll on the floor (1 tile, low).
Row 3: dummy = a straw training dummy on a post (1 tile, as tall as a person); map_table = a low table with a spread map,
two candles unlit (2 x 1 tiles, long side along the right back wall); lute_stand = a lute on a small wooden stand (1 tile);
shield_rack = three round painted shields on a low wooden rack (2 x 1 tiles, long side along the right back wall).
All lit like the other furniture (warm torchlight from the upper left), no text, no shadows outside each piece.
```

### 새 직업 8종 (포즈·걷기 시트 공통 인물 설명, 직업 캐릭터 공통 프롬프트 뒤에 붙임)
- **barbarian:** 성인 남성 바바리안. 털 장식 가죽 갑옷, 맨팔, 허리와 어깨에 두른 큰 천(마젠타), 등에 큰 양날 도끼.
- **bard:** 성인 여성 음유시인. 더블릿과 짧은 망토(마젠타), 깃털 달린 챙 모자(갈색), 등에 류트.
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
(the same person, the same stool, the same scale; seated, back to the viewer, facing up-right, writing with a quill
as if at a table; do NOT draw the table). Only the writing arm, hand and quill move; the head may tilt very slightly.
The body, the stool and the feet stay at exactly the same place in all three frames.
Row 1: write_a = the quill touching the page, hand to the left; write_b = the quill lifted a little, hand in the middle;
write_c = the quill touching the page, hand to the right.
```

## 검사 기준 (`--check`)
- 시트의 조각 수와 줄별 개수가 `sheets.json`과 정확히 같으면 `ok: true`.
- `problem`에 "pieces touching"이 나오면 조각 사이를 더 띄우거나 떨어진 파편을 없앤다.
- 화면에 쓰려면 기본 14장(`required`가 없는 시트)이 모두 `ok: true`여야 한다. 추가 시트는 `extra`에 따로 센다. 일부만 있으면 길드 화면 대신 "그림 준비 안 됨 (n/14)" 안내가 나온다.
