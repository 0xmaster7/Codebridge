declare module "ignore" {
  export interface Ignore {
    add(patterns: string | readonly string[]): Ignore;
    ignores(path: string): boolean;
  }

  export default function ignore(options?: { ignorecase?: boolean }): Ignore;
}
