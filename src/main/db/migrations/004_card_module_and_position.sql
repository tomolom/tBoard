-- Migration 004: add a repo-module link and an explicit ordering position to
-- cards.
--
--   * module   — an optional subfolder of the board's repo the card relates to
--                (discovered from the repo, like branches). Free text at the DB
--                level; the UI offers discovered folders.
--   * position — a REAL sort key within a (board_id, status) column, so cards
--                can be reordered by drag-and-drop. REAL (not INTEGER) allows a
--                card to be dropped between two others by averaging their
--                positions, with no bulk renumbering.
--
-- Both are additive columns, so no table rebuild is needed. Existing cards are
-- backfilled with position = id (a stable, distinct order) so ordering by
-- position matches the previous ins-order behavior.

ALTER TABLE cards ADD COLUMN module TEXT;
ALTER TABLE cards ADD COLUMN position REAL NOT NULL DEFAULT 0;

UPDATE cards SET position = id;

CREATE INDEX IF NOT EXISTS idx_cards_board_status_position ON cards(board_id, status, position);
