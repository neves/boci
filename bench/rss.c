// Tiny launcher: fork+exec argv, wait, write the child's peak RSS (KiB) to $RSS_OUT.
// A child's ru_maxrss includes the RSS it inherits at fork, so launching from Bun
// (~60 MB) would inflate every measurement; this launcher is ~1 MB.
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  pid_t pid = fork();
  if (pid == 0) {
    execvp(argv[1], argv + 1);
    _exit(127);
  }
  int status;
  struct rusage ru;
  wait4(pid, &status, 0, &ru);
  const char *out = getenv("RSS_OUT");
  FILE *f = out ? fopen(out, "w") : NULL;
  if (f) {
    fprintf(f, "%ld\n", ru.ru_maxrss);
    fclose(f);
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
