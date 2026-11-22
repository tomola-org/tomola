# Fictional operator settings

Development and tests use this fixture. It omits the optional `robots.txt`,
so `/robots.txt` returns 404 by default. In a deployed operator directory, the
operator chooses the crawler policy and the app serves the file verbatim after
startup. See [Operator settings](../../../docs/deploy.md#operator-settings).
