export const EXIT_SUCCESS = 0;
export const EXIT_DOMAIN_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_RUNTIME_ERROR = 3;

export function mapErrorToExitCode(code: string): number {
  switch (code) {
    case "invalid_argument":
    case "unknown_command":
    case "missing_argument":
    case "unknown_option":
    case "usage_error":
      return EXIT_USAGE_ERROR;
    case "not_found":
    case "version_conflict":
    case "precondition_failed":
    case "domain_rule_violated":
    case "validation_error":
      return EXIT_DOMAIN_ERROR;
    case "database_error":
    case "persistence_failed":
    case "io_error":
    default:
      return EXIT_RUNTIME_ERROR;
  }
}
