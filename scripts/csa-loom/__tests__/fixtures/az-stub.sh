#!/usr/bin/env bash
# Stub `az` used only by scripts/csa-loom/__tests__/purview-adopt-plan.test.mjs.
# Emulates the two core-CLI calls discover-purview-adopt-plan.sh makes, driven
# by $AZ_SCENARIO. It is a STUB OF AZURE, not of the script under test: the
# script's own logic runs unmodified.
sub=""
i=1
for arg in "$@"; do
  if [ "$arg" = "--subscription" ]; then
    j=$((i + 1))
    eval "sub=\${$j}"
  fi
  i=$((i + 1))
done

case "$1 $2" in
  "account list")
    if [ "$AZ_SCENARIO" = "nosubs" ]; then
      exit 0
    fi
    if [ "$AZ_SCENARIO" = "subsfail" ]; then
      echo "AADSTS700016: Application not found in the directory" >&2
      exit 1
    fi
    printf 'sub-aaa\n'
    printf 'sub-bbb\n'
    ;;

  "resource list")
    case "$AZ_SCENARIO" in
      atquota)
        # Five accounts in usgovvirginia, emitted deliberately OUT of name order
        # so the script's determinism is actually exercised.
        if [ "$sub" = "sub-aaa" ]; then
          printf 'pv-echo\trg-gov-e\tusgovvirginia\n'
          printf 'pv-alpha\trg-gov-a\tusgovvirginia\n'
          printf 'pv-delta\trg-gov-d\tusgovvirginia\n'
          printf 'pv-charlie\trg-gov-c\tusgovvirginia\n'
          printf 'pv-bravo\trg-gov-b\tusgovvirginia\n'
        fi
        ;;
      atquota-unreadable)
        # The quota is consumed by accounts this identity cannot see.
        if [ "$sub" = "sub-bbb" ]; then
          echo "AuthorizationFailed: does not have authorization to perform action" >&2
          exit 1
        fi
        ;;
      greenfield)
        :
        ;;
      crossregion)
        if [ "$sub" = "sub-aaa" ]; then
          printf 'pv-arizona\trg-az\tusgovarizona\n'
        fi
        ;;
      othersub)
        if [ "$sub" = "sub-bbb" ]; then
          printf 'pv-remote\trg-remote\tusgovvirginia\n'
        fi
        ;;
    esac
    ;;
esac
exit 0
