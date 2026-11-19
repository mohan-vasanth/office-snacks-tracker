"""Copy the Office Snacks tables from MySQL to an empty PostgreSQL database."""

import os
import sys

import mysql.connector
import psycopg
from psycopg import sql


TABLE_COLUMNS = {
    "employees": ("id", "name", "active", "created_at"),
    "snacks": ("id", "name", "active", "created_at"),
    "snack_records": ("id", "employee_id", "snack_id", "quantity", "taken_at"),
}


def required(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Set the {name} environment variable first.")
    return value


def main():
    source = mysql.connector.connect(
        host=os.getenv("MYSQL_HOST", "127.0.0.1"),
        port=int(os.getenv("MYSQL_PORT", "3306")),
        user=required("MYSQL_USER"),
        password=required("MYSQL_PASSWORD"),
        database=os.getenv("MYSQL_DATABASE", "office_snacks"),
        charset="utf8mb4",
    )
    target = psycopg.connect(required("SUPABASE_DATABASE_URL"))
    try:
        with source.cursor() as cursor:
            cursor.execute("SET time_zone = '+00:00'")
        source.start_transaction(
            isolation_level="REPEATABLE READ", readonly=True, consistent_snapshot=True
        )
        with target.transaction():
            target.execute("SET LOCAL TIME ZONE 'UTC'")
            counts = {}
            for table in TABLE_COLUMNS:
                row = target.execute(
                    sql.SQL("SELECT COUNT(*) FROM {} ").format(sql.Identifier(table))
                ).fetchone()
                counts[table] = row[0]
            if any(counts.values()):
                raise RuntimeError(
                    "Target tables must be empty to prevent duplicate imports. "
                    f"Current row counts: {counts}"
                )

            imported = {}
            for table, columns in TABLE_COLUMNS.items():
                column_sql = sql.SQL(", ").join(map(sql.Identifier, columns))
                with source.cursor() as cursor:
                    cursor.execute(
                        f"SELECT {', '.join(columns)} FROM {table} ORDER BY id"
                    )
                    rows = cursor.fetchall()
                if rows:
                    placeholders = sql.SQL(", ").join(sql.Placeholder() for _ in columns)
                    target.executemany(
                        sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
                            sql.Identifier(table), column_sql, placeholders
                        ),
                        rows,
                    )
                imported[table] = len(rows)

            for table in TABLE_COLUMNS:
                target.execute(
                    "SELECT setval(pg_get_serial_sequence(%s, 'id'), "
                    "GREATEST(COALESCE((SELECT MAX(id) FROM " + table + "), 1), 1), "
                    "EXISTS (SELECT 1 FROM " + table + "))",
                    (table,),
                )
        print("Migration completed. Imported rows: " + ", ".join(
            f"{table}={count}" for table, count in imported.items()
        ))
        print("The MySQL source was left unchanged.")
    finally:
        target.close()
        source.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Migration failed: {exc}", file=sys.stderr)
        sys.exit(1)
