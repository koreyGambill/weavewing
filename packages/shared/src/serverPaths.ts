/** The state subdirectory selected by the server's launch inputs. */
export const serverStateDirectoryName = (input: {
  readonly devUrl: URL | undefined;
  readonly baseDirIsExplicit?: boolean;
}) => (input.devUrl !== undefined && !input.baseDirIsExplicit ? "dev" : "userdata");
