/**
 * Function app entry point.
 *
 * Azure Functions v4 (the programming model used here) discovers functions by
 * loading this `main` module and running the `app.http(...)` registrations.
 * Import every function file here so they all get registered.
 */
import './functions/health';
import './functions/auth';
import './functions/users';
import './functions/audit';
import './functions/leads';
import './functions/customers';
import './functions/contracts';
import './functions/printers';
import './functions/warehouses';
import './functions/inventory';
import './functions/dispatch';
import './functions/field-service';
import './functions/helpdesk';
