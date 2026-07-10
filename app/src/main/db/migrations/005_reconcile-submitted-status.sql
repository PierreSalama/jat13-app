-- Migration 005 — reconcile submitted status (data-corrective). Applications imported before the v11
-- importer learned to promote a Saved row that carries a real submitted_at. Symptom: 536 applied jobs
-- displayed as "Saved" and the Applications "Applied" filter was empty, while the dashboard funnel (which
-- reads submitted_at) counted them as Applied — the two views disagreed. This aligns them.
--
-- Shape-idempotent: only touches rows that are still 'tracked' yet carry a submit timestamp. A fresh
-- import (post-fix) never produces such rows, so on a clean DB this updates nothing.
UPDATE applications
   SET status = 'submitted'
 WHERE status = 'tracked'
   AND submitted_at IS NOT NULL;
