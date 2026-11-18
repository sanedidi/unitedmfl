-- A shirt number may carry letters («Z10»): it is text now, not an integer.
ALTER TABLE players ALTER COLUMN number TYPE TEXT USING CASE WHEN number BETWEEN 0 AND 9999 THEN number::text END;
ALTER TABLE lineups ALTER COLUMN number TYPE TEXT USING CASE WHEN number BETWEEN 0 AND 9999 THEN number::text END;

-- The numeric part, for ordering a squad: 2 < 10 < Z10; no digits → last.
CREATE OR REPLACE FUNCTION jersey_ord(n TEXT) RETURNS INT
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT NULLIF(left(regexp_replace(coalesce(n, ''), '[^0-9]', '', 'g'), 9), '')::int $$;
