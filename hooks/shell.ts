/** `<Git>\bin\bash.exe` of the Git for Windows whose exec path is `<Git>\mingw64\libexec\git-core`. */
export function bashUnder(execPath: string): string {
  const m = /^(.+?)[\\/]+(?:mingw64|mingw32|clangarm64|ucrt64)[\\/]+libexec[\\/]+git-core[\\/]*$/i.exec(execPath)
  if (m === null) throw new Error(`crew: no Git Bash: git's exec path ${execPath} is not inside a Git for Windows install`)
  return `${m[1]!.replace(/\//g, '\\')}\\bin\\bash.exe`
}
