ALTER TABLE notes
  DROP CONSTRAINT notes_link_platform_check,
  ADD CONSTRAINT notes_link_platform_check
    CHECK (
      link_platform IN ('web', 'xiaohongshu', 'xiaoyuzhou', 'bilibili')
    );
