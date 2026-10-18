DO $$ DECLARE v_definition text; BEGIN
 v_definition:=pg_get_functiondef('public.handheld_work_items(uuid,uuid[],boolean,integer,timestamptz,uuid)'::regprocedure);
 IF position('t.location_id=ANY(locs.ids) AND NOT EXISTS' IN v_definition)>0 THEN
 v_definition:=replace(v_definition,'t.location_id=ANY(locs.ids) AND NOT EXISTS','(t.location_id=ANY(locs.ids) OR (p_include_unlocated AND t.location_id IS NULL)) AND NOT EXISTS');
 ELSE RAISE EXCEPTION 'work_items_definition_unexpected'; END IF;
 EXECUTE v_definition;
END $$;