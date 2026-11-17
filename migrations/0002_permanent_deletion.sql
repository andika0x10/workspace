-- Remove legacy deleted content from receipts before removing its source rows.
UPDATE mutation_receipts
SET response = json_object('type', 'change', 'seq', json_extract(response, '$.seq'), 'mutationId', id,
  'deletedBoardId', COALESCE(json_extract(response, '$.board.id'), json_extract(response, '$.card.boardId'), json_extract(response, '$.deletedBoardId'), json_extract(response, '$.deletedCard.boardId')))
WHERE COALESCE(json_extract(response, '$.board.id'), json_extract(response, '$.card.boardId'), json_extract(response, '$.deletedBoardId'), json_extract(response, '$.deletedCard.boardId'))
  IN (SELECT id FROM boards WHERE deleted_at IS NOT NULL);

UPDATE mutation_receipts
SET response = json_object('type', 'change', 'seq', json_extract(response, '$.seq'), 'mutationId', id,
  'deletedCard', json_object('id', json_extract(response, '$.card.id'), 'boardId', json_extract(response, '$.card.boardId')))
WHERE json_extract(response, '$.card.id') IN (SELECT id FROM cards WHERE json_extract(data, '$.deletedAt') IS NOT NULL);

DELETE FROM cards WHERE board_id IN (SELECT id FROM boards WHERE deleted_at IS NOT NULL)
  OR json_extract(data, '$.deletedAt') IS NOT NULL;
DELETE FROM device_state WHERE board_id IN (SELECT id FROM boards WHERE deleted_at IS NOT NULL);
DELETE FROM boards WHERE deleted_at IS NOT NULL;
UPDATE cards SET data = json_remove(data, '$.deletedAt');
UPDATE mutation_receipts SET response = json_remove(response, '$.card.deletedAt', '$.board.deletedAt');
ALTER TABLE boards DROP COLUMN deleted_at;

CREATE INDEX IF NOT EXISTS mutation_receipts_card ON mutation_receipts (
  COALESCE(json_extract(response, '$.card.id'), json_extract(response, '$.deletedCard.id'))
);
CREATE INDEX IF NOT EXISTS mutation_receipts_board ON mutation_receipts (
  COALESCE(json_extract(response, '$.board.id'), json_extract(response, '$.card.boardId'), json_extract(response, '$.deletedBoardId'), json_extract(response, '$.deletedCard.boardId'))
);
