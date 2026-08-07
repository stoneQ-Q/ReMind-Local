WITH rebuilt AS (
  SELECT transcription.user_id,
         transcription.note_id,
         LEFT(
           split_part(
             note.source_page_text,
             E'\n\n音频转写\n',
             1
           ) || E'\n\n音频转写\n' ||
           COALESCE(
             (
               SELECT string_agg(
                 '[' ||
                 lpad(
                   floor((entry.segment ->> 'startSeconds')::numeric / 3600)::integer::text,
                   2,
                   '0'
                 ) || ':' ||
                 lpad(
                   floor(mod((entry.segment ->> 'startSeconds')::numeric, 3600) / 60)::integer::text,
                   2,
                   '0'
                 ) || ':' ||
                 lpad(
                   floor(mod((entry.segment ->> 'startSeconds')::numeric, 60))::integer::text,
                   2,
                   '0'
                 ) || '] ' ||
                 (entry.segment ->> 'text'),
                 E'\n' ORDER BY entry.ordinality
               )
               FROM jsonb_array_elements(transcription.segments_json)
                 WITH ORDINALITY AS entry(segment, ordinality)
               WHERE NULLIF(trim(entry.segment ->> 'text'), '') IS NOT NULL
             ),
             transcription.transcript
           ),
           80000
         ) AS source_page_text
  FROM xiaoyuzhou_transcriptions AS transcription
  JOIN notes AS note
    ON note.user_id = transcription.user_id
   AND note.id = transcription.note_id
  WHERE transcription.status = 'succeeded'
    AND NULLIF(trim(transcription.transcript), '') IS NOT NULL
    AND note.deleted_at IS NULL
    AND length(note.source_page_text) <= 24000
)
UPDATE notes AS note
SET source_page_text = rebuilt.source_page_text,
    sync_version = note.sync_version + 1,
    updated_at = now()
FROM rebuilt
WHERE note.user_id = rebuilt.user_id
  AND note.id = rebuilt.note_id
  AND note.source_page_text IS DISTINCT FROM rebuilt.source_page_text;
