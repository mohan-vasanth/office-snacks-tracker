# REST API

Base path: `/api`. All endpoints require HTTP Basic authentication over HTTPS in deployment. Credentials are runtime environment values and Spring Security stores their BCrypt hashes in memory.

## Roles

- `ADMIN`: employee/snack management, dashboard, reports, all history.
- `EMPLOYEE`: read employee/snack selection lists and create/view snack records. The submitted employee ID is replaced with configured `APP_EMPLOYEE_ID` for employee role.

## Endpoints

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET/POST | `/employees` | GET both roles, POST admin | List or create employee |
| GET/PUT | `/employees/{id}` | GET both roles, PUT admin | Read or update/activate employee |
| GET/POST | `/snacks` | GET both roles, POST admin | List or create snack |
| GET/PUT | `/snacks/{id}` | GET both roles, PUT admin | Read or update/activate snack |
| POST | `/records` | both roles | Create one quantity-positive record; timestamp is server-generated |
| POST | `/records/batch` | both roles | Create multiple snack records atomically for one employee; each item is a separate record |
| PUT | `/records/{id}` | both roles | Edit snack and quantity; employees can edit only their own records, admins can edit any record |
| DELETE | `/records/{id}` | both roles | Delete a record; employees can delete only their own records, admins can delete any record |
| GET | `/records` | both roles | Filter by `date`, `from`, `to`, `employeeId`, `snackId` |
| GET | `/records/{id}` | both roles | Read one record |
| GET | `/dashboard/summary?date=YYYY-MM-DD` | admin | Employee/snack counts and date totals |
| GET | `/dashboard/employee-summary?date=...` | admin | Employee totals for day |
| GET | `/dashboard/snack-summary?date=...` | admin | Snack totals for day, sorted popular first |
| GET | `/reports/daily?date=YYYY-MM-DD` | admin | Daily totals and grouped breakdowns |
| GET | `/reports/weekly?from=YYYY-MM-DD&to=YYYY-MM-DD` | admin | Arbitrary date range totals and breakdowns |
| GET | `/reports/monthly?year=YYYY&month=MM` | admin | Calendar month totals and breakdowns |

Create employee/snack body: `{"name":"Mohan","active":true}`. Create record body: `{"employeeId":1,"snackId":1,"quantity":2}`. Batch body: `{"employeeId":1,"items":[{"snackId":1,"quantity":2},{"snackId":7,"quantity":1}]}`. Edit body: `{"employeeId":1,"snackId":1,"quantity":3}`. Record edits preserve the original `takenAt`; employees can only edit or delete their own records. Record responses include employee and snack labels and UTC `takenAt` ISO timestamp; format as Asia/Kolkata in clients. Delete returns 204. Invalid input returns 400, unauthenticated returns 401, forbidden role returns 403, missing entities return 404, and duplicate names return 409.

The current history endpoint returns all matching records; the UI paginates its visible rows. For larger deployments, replace this with a server-side `Pageable` endpoint.
