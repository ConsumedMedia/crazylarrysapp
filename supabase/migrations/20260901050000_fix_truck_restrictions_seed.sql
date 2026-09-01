-- =============================================================================
-- Crazy Larry's Dumpsters — fix: seed the truck_restrictions rows
-- =============================================================================
-- 20260901040000 tried to insert the trucks and their restriction rows in one
-- data-modifying CTE. Postgres executes every part of such a CTE against the
-- same snapshot, so the main INSERT ... SELECT FROM public.trucks could not see
-- the trucks the CTE had just inserted — on a fresh database that select
-- returned nothing and zero restriction rows were written.
--
-- Here the trucks already exist as a committed prior statement, so a plain
-- INSERT ... SELECT sees them. Idempotent via the (truck_id, dimension,
-- match_value) unique constraint.

insert into public.truck_restrictions
  (truck_id, dimension, match_value, match_mode, enforcement, source_phrase)
select
  t.id, r.dimension, r.match_value, r.match_mode, r.enforcement, r.source_phrase
from public.trucks t
join (
  values
    ('Pepperoni', 'job_tag'::public.truck_restriction_dimension, 'heavy_construction',
       'exact'::public.truck_restriction_match_mode, 'block'::public.truck_restriction_enforcement,
       'Do not use for heavy construction loads'),
    ('Pepperoni', 'customer', 'Shaffer Construction', 'contains', 'block',
       'including Shaffer Construction jobs'),
    ('Pepperoni', 'customer', 'Bluefield', 'contains', 'block',
       'Bluefield jobs'),
    ('Pepperoni', 'job_tag', 'roofing', 'exact', 'block',
       'any roofing jobs'),
    ('Pepperoni', 'debris_type', 'stone', 'contains', 'block',
       'any stone or concrete jobs'),
    ('Pepperoni', 'debris_type', 'concrete', 'contains', 'block',
       'any stone or concrete jobs'),
    ('Pepperoni', 'customer', 'NoCo Exteriors', 'contains', 'block',
       'NoCo Exteriors jobs must never be assigned to this truck')
) as r(nickname, dimension, match_value, match_mode, enforcement, source_phrase)
  on t.nickname = r.nickname
on conflict (truck_id, dimension, match_value) do nothing;
