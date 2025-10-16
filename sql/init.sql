-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Pages table
CREATE TABLE IF NOT EXISTS web_pages (
  id BIGSERIAL PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  status INT,
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chunks table
CREATE TABLE IF NOT EXISTS web_chunks (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL REFERENCES web_pages(url) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536)
);

CREATE INDEX IF NOT EXISTS web_chunks_url_idx ON web_chunks(url);
CREATE INDEX IF NOT EXISTS web_chunks_embedding_idx ON web_chunks USING ivfflat (embedding vector_cosine_ops);

-- If an older function exists with a different signature, drop it first
DROP FUNCTION IF EXISTS match_web_chunks(vector, integer, double precision);

-- Simple ANN search: returns chunk rows with distance
CREATE FUNCTION match_web_chunks(query_embedding vector, match_count integer DEFAULT 5, max_distance double precision DEFAULT 0.4)
RETURNS TABLE(
  id BIGINT,
  url TEXT,
  chunk_index INT,
  content TEXT,
  distance DOUBLE PRECISION
) AS $$
  SELECT wc.id, wc.url, wc.chunk_index, wc.content,
         1 - (wc.embedding <#> query_embedding) AS distance
  FROM web_chunks wc
  WHERE wc.embedding IS NOT NULL
  ORDER BY wc.embedding <#> query_embedding
  LIMIT match_count;
$$ LANGUAGE sql STABLE;
