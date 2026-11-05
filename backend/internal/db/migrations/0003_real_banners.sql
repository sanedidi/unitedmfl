-- Hero banners as published on unitedmfl.com (home page slider, June 2026):
-- images, dates, venues and ticket links. Remote images are copied into
-- /uploads by the API on start-up (see api/mirror.go).
-- Only seed rows that were never edited in the admin (no images yet) are touched.

UPDATE banners SET
  title = 'Yulduzlar o‘yini', badge = 'TEZ KUNDA', badge_type = 'category',
  event_date = '2026-07-04', event_time = '20:00',
  venue = 'Jar stadioni, Katta maydon — Toshkent, Shayxontohur t., Laylito‘g‘on ko‘chasi 3',
  cta_label = 'Chipta sotib olish', cta_url = 'https://gtickets.uz/event/unitedmfl',
  image_desktop = 'https://www.unitedmfl.com/wp-content/uploads/2026/06/banner-mfl-match-zvezd.webp',
  image_mobile  = 'https://www.unitedmfl.com/wp-content/uploads/2026/06/banner_mfl_match_zvezd_mobilnaya_versiya_uz.webp',
  ord = 1, status = 'published', is_active = true, updated_at = now()
WHERE title = 'Yulduzlar o''yini' AND image_desktop = '';

UPDATE banners SET
  title = 'Final United MFL', badge = 'FINAL', badge_type = 'accent',
  event_date = '2026-07-04', event_time = '20:00', venue = 'Jar stadioni, Toshkent',
  cta_label = 'Chipta sotib olish', cta_url = 'https://gtickets.uz/event/unitedmfl',
  image_desktop = 'https://www.unitedmfl.com/wp-content/uploads/2026/06/banner-mfl-finalnyj-match-zvezd-1.webp',
  image_mobile  = 'https://www.unitedmfl.com/wp-content/uploads/2026/06/banner_mfl_finalnyj_match_zvezd_mobilnaya_versiya-1.webp',
  ord = 2, status = 'published', is_active = true, updated_at = now()
WHERE title = 'Final United MFL' AND image_desktop = '';

UPDATE banners SET
  title = 'A1 — Blacstone', badge = 'YARIM FINAL', badge_type = 'stage',
  event_date = '2026-06-19', event_time = '18:30', venue = 'Jar stadioni, Kichik maydon — Toshkent',
  cta_label = 'Chipta sotib olish', cta_url = 'https://gtickets.uz/sports/event/20-30025?date=2026-06-18',
  image_desktop = 'https://www.unitedmfl.com/wp-content/uploads/2026/06/banner-mfl-polufinal-2-uz-1.webp',
  image_mobile  = 'https://www.unitedmfl.com/wp-content/uploads/2026/06/banner_mfl_polufinal_mobilnaya_versiya_2_uz.webp',
  ord = 4, status = 'published', is_active = true, updated_at = now()
WHERE title = 'A1 — Blacstone' AND image_desktop = '';

-- The match poster (gticket) is the fourth slide on unitedmfl.com; it reuses the
-- former «Chorak final» draft row (the site's slide text says «chorak final»,
-- while the poster and the other banner say «yarim final» — still to be confirmed).
UPDATE banners SET
  title = 'A1 — Blacstone: 19.06, 18:30', badge = 'JAR STADIONI', badge_type = 'stage',
  event_date = '2026-06-19', event_time = '18:30', venue = 'Jar stadioni, Toshkent',
  cta_label = 'Chipta sotib olish', cta_url = 'https://gtickets.uz/sports/event/20-30025?date=2026-06-18',
  image_desktop = 'https://www.unitedmfl.com/wp-content/uploads/2026/06/gticket_19.06_page-0001.webp',
  image_mobile  = 'https://www.unitedmfl.com/wp-content/uploads/2026/06/g-ticket-430-x-932-piks.2_page-0001.webp',
  ord = 3, status = 'published', is_active = true, updated_at = now(),
  note = 'unitedmfl.com: slayd matnida «Chorak final», afishada sana 19.06.2026 18:30'
WHERE title = 'Chorak final: A1 — Blacstone' AND image_desktop = '';
