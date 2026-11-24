BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.qr_jtc_link
  ADD COLUMN pair_number smallint,
  ADD CONSTRAINT qr_jtc_link_pair_number_check
    CHECK (pair_number IN (1, 2)) NOT VALID;

COMMIT;
