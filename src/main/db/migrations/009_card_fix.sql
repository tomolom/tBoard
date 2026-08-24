-- Migration 009: a separate "fix" field on cards.
--
-- Bug cards often record the resolution/fix separately from the bug
-- description. Storing it in its own column means the UI can show it in a
-- dedicated box instead of appending it to the bottom of the description.
-- Additive, nullable column — no table rebuild, existing cards get NULL.

ALTER TABLE cards ADD COLUMN fix TEXT;
