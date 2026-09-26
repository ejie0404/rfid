ALTER TABLE scheduled_move_outs
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_processing_error text;

CREATE INDEX scheduled_move_out_retry_queue
  ON scheduled_move_outs((COALESCE(next_attempt_at,effective_at)),effective_at,id)
  WHERE status='scheduled';
