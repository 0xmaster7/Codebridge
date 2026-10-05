import { dirname } from "node:path";

export type GitEnvironmentOptions = {
  readonly home: string;
  readonly xdgConfigHome: string;
};

export class EnvironmentSanitizer {
  public forGit(options: GitEnvironmentOptions): NodeJS.ProcessEnv {
    return {
      HOME: options.home,
      XDG_CONFIG_HOME: options.xdgConfigHome,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    };
  }

  public forDocker(
    dockerExecutable: string,
    profileEnvironment: Record<string, string>,
  ): NodeJS.ProcessEnv {
    const safe = Object.fromEntries(
      Object.entries(profileEnvironment).filter(
        ([key, value]) =>
          /^[A-Z][A-Z0-9_]{0,63}$/.test(key) &&
          !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) &&
          value.length <= 512,
      ),
    );
    return {
      HOME: "/nonexistent",
      LANG: "C",
      LC_ALL: "C",
      PATH: `${dirname(dockerExecutable)}:/usr/bin:/bin`,
      ...safe,
    };
  }
}
