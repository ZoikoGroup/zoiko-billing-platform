"""
migrations/create_all
---------------------
Fresh-schema bootstrap for the standalone Payroll Platform.

There is NO alembic in this codebase. The schema is created in one shot
with ``Base.metadata.create_all`` against an empty database. This package
documents that bootstrap and provides a standalone runner script.
"""
