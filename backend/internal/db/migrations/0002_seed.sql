-- United MFL — real data published on unitedmfl.com (June 2026).
-- Groups are PROVISIONAL (inferred from fixture pairings) — group_is_provisional = true.

INSERT INTO seasons (name, slug, is_active, teams_planned, matches_planned)
VALUES ('United MFL 2026', '2026', true, 16, 31)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO stages (season_id, name, kind, ord, status, note)
SELECT s.id, v.name, v.kind, v.ord, v.status, v.note
FROM seasons s,
(VALUES
  ('Guruh bosqichi', 'group',   1, 'finished',  '16 jamoa · juftliklar bo''yicha o''yinlar'),
  ('Chorak final',   'quarter', 2, 'finished',  'Sanalar saytda e''lon qilinmagan'),
  ('Yarim final',    'semi',    3, 'scheduled', 'Saytda A1 — Blacstone «chorak final» deb ham ko''rsatilgan; bosqichni tasdiqlash kerak'),
  ('Final',          'final',   4, 'scheduled', 'Final + Yulduzlar o''yini · Jar stadioni')
) AS v(name, kind, ord, status, note)
WHERE s.slug = '2026';

INSERT INTO teams (slug, name, short_name, group_label) VALUES
  ('a1',            'A1',            'A1',  'A'),
  ('avengers',      'Avengers',      'AV',  'A'),
  ('tanish-bilish', 'Tanish Bilish', 'TB',  'A'),
  ('f-river',       'F-River',       'FR',  'A'),
  ('blacstone',     'Blacstone',     'BS',  'B'),
  ('benom',         'Benom',         'BN',  'B'),
  ('galaxy',        'Galaxy',        'GX',  'B'),
  ('sherdor',       'Sherdor',       'SH',  'B'),
  ('cosmos',        'Cosmos',        'CS',  'C'),
  ('you-too',       'You Too',       'YT',  'C'),
  ('alliance',      'Alliance',      'AL',  'C'),
  ('ufu',           'UFU',           'UFU', 'C'),
  ('prime-xi',      'Prime XI',      'PXI', 'D'),
  ('afruz',         'Afruz',         'AF',  'D'),
  ('label-boys',    'Label Boys',    'LB',  'D'),
  ('emperia',       'Emperia',       'EM',  'D')
ON CONFLICT (slug) DO NOTHING;

-- Group-stage results (real, Asia/Tashkent time)
INSERT INTO matches (season_id, stage_id, round, home_team_id, away_team_id, kickoff_at, status, period, home_score, away_score)
SELECT s.id, st.id, 'Guruh', h.id, a.id, v.ko::timestamptz, 'finished', 'FT', v.hs, v.as_
FROM seasons s
JOIN stages st ON st.season_id = s.id AND st.kind = 'group'
JOIN (VALUES
  ('a1',            'f-river',   '2026-03-02 18:50+05', 4, 0),
  ('tanish-bilish', 'avengers',  '2026-03-03 18:50+05', 3, 8),
  ('benom',         'galaxy',    '2026-03-07 16:00+05', 3, 3),
  ('sherdor',       'blacstone', '2026-03-08 15:30+05', 1, 2),
  ('ufu',           'cosmos',    '2026-03-14 17:00+05', 1, 4),
  ('you-too',       'alliance',  '2026-03-15 15:00+05', 2, 1),
  ('label-boys',    'afruz',     '2026-03-23 18:20+05', 1, 2),
  ('prime-xi',      'emperia',   '2026-03-24 18:20+05', 5, 2),
  ('a1',            'avengers',  '2026-03-28 18:20+05', 2, 1),
  ('tanish-bilish', 'f-river',   '2026-03-29 18:20+05', 3, 1)
) AS v(hs_slug, as_slug, ko, hs, as_) ON true
JOIN teams h ON h.slug = v.hs_slug
JOIN teams a ON a.slug = v.as_slug
WHERE s.slug = '2026';

-- Semi-final (real: official banner)
INSERT INTO matches (season_id, stage_id, round, home_team_id, away_team_id, kickoff_at, venue, ticket_url, status, show_in_hero)
SELECT s.id, st.id, 'Yarim final', h.id, a.id, '2026-06-19 18:30+05', 'Jar stadioni, Toshkent', 'https://gtickets.uz', 'scheduled', true
FROM seasons s JOIN stages st ON st.season_id = s.id AND st.kind = 'semi'
JOIN teams h ON h.slug = 'a1' JOIN teams a ON a.slug = 'blacstone'
WHERE s.slug = '2026';

-- Final (teams not announced)
INSERT INTO matches (season_id, stage_id, round, kickoff_at, venue, ticket_url, status, show_in_hero)
SELECT s.id, st.id, 'Final', '2026-07-04 20:00+05', 'Jar stadioni, Toshkent', 'https://gtickets.uz', 'scheduled', true
FROM seasons s JOIN stages st ON st.season_id = s.id AND st.kind = 'final'
WHERE s.slug = '2026';

INSERT INTO news (slug, title, category, excerpt, status, published_at, on_home) VALUES
  ('final-united-mfl-4-iyul-jar-stadioni', 'Final United MFL — 4-iyul, Jar stadioni: Yulduzlar o''yini', 'FINAL',
   'Mavsum finali va yulduzlar o''yini 4-iyul kuni soat 20:00 da Toshkentdagi Jar stadionida bo''lib o''tadi. Chiptalar gtickets.uz saytida.', 'published', '2026-06-20 10:00+05', true),
  ('yarim-final-a1-blacstone', 'Yarim final: A1 va Blacstone Jar stadionida uchrashadi', 'PLEY-OFF',
   'United MFL 2026 yarim finalida A1 va Blacstone 19-iyun kuni soat 18:30 da Jar stadionida to''qnash keladi.', 'published', '2026-06-17 10:00+05', true),
  ('yulduzlar-oyini-4-iyul', 'Yulduzlar o''yini: 4-iyul, 20:00, Jar stadioni', 'ANONS',
   'Yulduzlar o''yini final kuni — 4-iyul, soat 20:00 da Jar stadionida.', 'published', '2026-07-02 10:00+05', false),
  ('a1-blacstone-chiptalar', 'A1 — Blacstone: chiptalar gtickets.uz''da sotuvda', 'CHIPTALAR',
   'Rasmiy chipta hamkori — gtickets.uz.', 'published', '2026-06-15 10:00+05', false),
  ('final-homiylar', 'Final United MFL: homiylar — realme, Click, Wildberries', 'LIGA',
   'Final homiylari: realme, Click, Wildberries.', 'published', '2026-06-20 12:00+05', false),
  ('guruh-bosqichi-49-gol', 'Guruh bosqichi: e''lon qilingan 10 ta matchda 49 ta gol', 'NATIJALAR',
   'Saytda e''lon qilingan 10 ta guruh matchida jami 49 ta gol urildi.', 'published', '2026-03-30 10:00+05', false),
  ('avengers-eng-kop-gol', 'Avengers: guruh bosqichidagi eng ko''p gol (9)', 'STATISTIKA',
   'E''lon qilingan natijalar bo''yicha Avengers guruh bosqichida 9 ta gol urdi.', 'draft', NULL, false)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO banners (title, badge, badge_type, event_date, event_time, venue, cta_label, cta_url, ord, status, is_active, note) VALUES
  ('Final United MFL', 'FINAL',       'accent',   '2026-07-04', '20:00', 'Jar stadioni, Toshkent', 'Chipta sotib olish', 'https://gtickets.uz', 1, 'published', true,  ''),
  ('A1 — Blacstone',   'YARIM FINAL', 'stage',    '2026-06-19', '18:30', 'Jar stadioni, Toshkent', 'Chipta sotib olish', 'https://gtickets.uz', 2, 'published', true,  ''),
  ('Yulduzlar o''yini','ANONS',       'category', '2026-07-04', '20:00', 'Jar stadioni, Toshkent', 'Chipta sotib olish', 'https://gtickets.uz', 3, 'published', true,  ''),
  ('Chorak final: A1 — Blacstone', 'CHORAK FINAL', 'stage', NULL, '', '', 'Chipta sotib olish', 'https://gtickets.uz', 4, 'draft', false,
   'Bosqich tasdiqlanmagan: saytda «chorak», bannerda «yarim»');

INSERT INTO products (slug, name, category, price_uzs, status, ord, featured) VALUES
  ('futbolka-mfl-black', 'Futbolka MFL Black', 'Kiyim',      259000,  'active',    1, true),
  ('sharf-mfl',          'Sharf MFL',          'Aksessuar',  159000,  'active',    2, true),
  ('butilka-mfl',        'Butilka MFL',        'Aksessuar',  59000,   'active',    3, true),
  ('kepka-mfl',          'Kepka MFL',          'Aksessuar',  99000,   'active',    4, true),
  ('suvenir-mfl',        'Suvenir MFL',        'Suvenir',    99000,   'active',    5, false),
  ('toplam-mfl',         'To''plam MFL',       'To''plam',   1999000, 'active',    6, false),
  ('ryukzak-mfl',        'Ryukzak MFL',        'Aksessuar',  299000,  'active',    7, false),
  ('vetrovka-mfl',       'Vetrovka MFL',       'Kiyim',      899000,  'active',    8, false),
  ('longsliv-mfl',       'Longsliv MFL',       'Kiyim',      799000,  'active',    9, false),
  ('xudi-mfl',           'Xudi MFL',           'Kiyim',      4990000, 'in_review', 10, false)
ON CONFLICT (slug) DO NOTHING;
