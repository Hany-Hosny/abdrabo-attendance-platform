# Gender-aware WhatsApp templates

## Rollout

1. Create an isolated database branch or backup and run the additive migration. Verify the five categories have four `male` slots, four `female` slots, and one active `neutral` fallback each.
2. Stop or drain every old WhatsApp worker. An old worker reads the category-wide legacy pool and must not run while the new gender-specific assignments are active.
3. Deploy the backend and frontend together, run the migration, and start only workers containing the claim-scoped gender selector.
4. Send a controlled local/staging test using synthetic male, female, and unknown-gender students. Confirm the job snapshot contains the template ID, version, audience, slot, gender, and body.
5. Activate automatic sending only after the worker and configuration checks pass. No production provider send is part of this procedure.

## Rotation and retries

Male and female cursors are independent for each category. Basic rotation advances in stable slot order among enabled valid assignments. If the last provider-accepted assignment for the same student/category/audience would repeat, the next eligible slot is used when there is an alternative; this wording preference can change exact distribution. A valid job snapshot is reused on ordinary retries and is reselected only when its current gender or assignment is no longer eligible.

Selection and cursor advancement commit together before any provider request. Provider delivery completion is outside that transaction; a request already in flight cannot be retracted. A gender correction made before selection affects that job, while a correction after provider start affects future jobs and requires the existing delivery-unknown/manual-retry safeguards.

## Rollback

Drain the new workers before restoring code. Do not delete template rows, rotation state, jobs, or message history. If code rollback is required, keep the new gender-specific rows inactive until every old worker is stopped, or restore the previous code and previous configuration snapshot together. Never expose the female assignments to an old worker that cannot filter by audience. The additive columns and snapshots can remain in place for a later forward deployment.
