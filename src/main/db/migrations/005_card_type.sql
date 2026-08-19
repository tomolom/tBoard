-- Migration 005: add a card type (task / bug / feature).
--
-- Lightweight categorization so cards can be marked as bugs, features, or plain
-- tasks and filtered by it. Additive column, no table rebuild. Existing cards
-- default to 'task'.

ALTER TABLE cards ADD COLUMN type TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task', 'bug', 'feature'));

CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);
