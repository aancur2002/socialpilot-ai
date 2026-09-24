-- Approximate-nearest-neighbour index for knowledge-base semantic search
-- (cosine distance). Queries always also filter on "clientId" for tenant isolation.
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_embedding_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ("embedding" vector_cosine_ops);
