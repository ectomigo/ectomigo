SELECT * FROM one;
SELECT * FROM myview;

SELECT id, val, val2 FROM one;
SELECT id, val, an_int FROM one;

UPDATE one SET val = 'hi';

select one.id, t.val
from one
join two as t on t.one_id = one.id
where one.an_int > 0;

SELECT * from two;
