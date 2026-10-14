-- +goose Up
-- The editor form of a user, saved every few seconds without a commit. slug is empty for a new entry.
CREATE TABLE autosaves (
    site_id    INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    collection TEXT    NOT NULL,
    slug       TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (site_id, user_id, collection, slug)
);

-- +goose Down
DROP TABLE autosaves;
