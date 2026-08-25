-- Contact suggestion cleanup and identity deletion need a full covering index.
-- The existing pending-only index is optimized for the review queue but does
-- not cover the foreign key for resolved and dismissed suggestions.

create index contact_suggestions_identity_idx
  on public.contact_suggestions (identity_id);
