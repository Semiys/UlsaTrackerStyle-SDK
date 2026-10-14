.bail on
SET memory_limit = '128MB';
SET threads = 2;
INSTALL quack;
LOAD quack;
-- The CLI keeps serving while its standard input remains open.
-- Hide the returned token from container logs.
.output /dev/null
CALL quack_serve('quack:0.0.0.0:9494', token := getenv('DATABASE_TOKEN'), allow_other_hostname := true);
.output stdout
