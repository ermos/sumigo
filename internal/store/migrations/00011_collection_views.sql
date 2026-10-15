-- +goose Up
-- How a user lists a collection: columns, sort, filters and page size, as the UI sends them.
CREATE TABLE collection_views (
    site_id    INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    collection TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    PRIMARY KEY (site_id, user_id, collection)
);

-- +goose Down
DROP TABLE collection_views;
