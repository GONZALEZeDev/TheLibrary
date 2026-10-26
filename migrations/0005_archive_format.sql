-- The format of each match's archive file: NULL for a file written before this column existed (format 1),
-- 1 for a format-1 file whose refresh failed for good, 2 for the current format.
ALTER TABLE matches ADD COLUMN archive_format INTEGER CHECK (archive_format IS NULL OR archive_format >= 1);
