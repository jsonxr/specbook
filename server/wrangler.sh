#!/usr/bin/env bash
set -euo pipefail

# ── wrangler, with the Cloudflare credentials read from LastPass ─────────────
#
#   ./wrangler.sh deploy
#   ./wrangler.sh secret put TURN_KEY_ID
#   ./wrangler.sh <any wrangler arguments>
#
# Works the same way as tribes' scripts/deployment/bin/cf.sh. Every run asks for
# the LastPass master password, reads CLOUDFLARE_API_TOKEN (and
# CLOUDFLARE_ACCOUNT_ID, if the note has it) from one secure note, hands them to
# this one wrangler process, and locks the vault again when the run ends. That
# includes Ctrl-C. Nothing is written to disk.
#
# The vault's token replaces whatever CLOUDFLARE_API_TOKEN your shell holds. A
# stale token left in the shell is exactly what breaks a bare `wrangler deploy`.
#
# The token is the password of the LastPass Password entry
# `Cloudflare/cloudflare-specbook-provision` (or SPECBOOK_CF_NOTE).
# On the first run, or whenever that token stops working, the script mints a new
# one, like tribes does: it uses the master token in `Cloudflare/cloudflare-master`
# (or SPECBOOK_BOOTSTRAP_NOTE) to create `specbook-provision`, scoped to this
# account and the custom domain's zone, and saves it in the note.
#
# The LastPass username comes from LPASS_USERNAME in the environment, then from
# LPASS_USERNAME=... in server/.env (gitignored), then from a prompt.

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NOTE="${SPECBOOK_CF_NOTE:-Cloudflare/cloudflare-specbook-provision}"
BOOTSTRAP_NOTE="${SPECBOOK_BOOTSTRAP_NOTE:-Cloudflare/cloudflare-master}"
TOKEN_NAME="specbook-provision"

fail() {
  printf '✘ %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

# One value from server/.env. The file is read, never sourced, so nothing else
# in it runs.
env_file_value() {
  local key="$1" line value
  [[ -f "$SERVER_DIR/.env" ]] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$SERVER_DIR/.env" | head -1) || return 0
  value=${line#*=}
  value=${value%$'\r'}
  if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
    value=${value:1:${#value}-2}
  fi
  printf '%s' "$value"
}

command -v lpass >/dev/null 2>&1 ||
  fail "lastpass-cli is not installed." "brew install lastpass-cli"
command -v wrangler >/dev/null 2>&1 ||
  fail "wrangler is not installed." "mise install (from server/), or npm i -g wrangler"

if [[ ! -t 0 ]]; then
  fail "This needs a terminal, because LastPass asks for your master password." \
    "Claude Code's \`!\` prefix has no terminal. Run it in a separate terminal window:" \
    "  $SERVER_DIR/wrangler.sh ${*:-deploy}"
fi

user="${LPASS_USERNAME:-}"
[[ -n "$user" ]] || user=$(env_file_value LPASS_USERNAME)
# Read before the logout below deletes it.
[[ -n "$user" ]] || user=$(cat "$HOME/.lpass/username" 2>/dev/null || true)
if [[ -z "$user" ]]; then
  read -r -p "LastPass username (email): " user </dev/tty
  [[ -n "$user" ]] || fail "No LastPass username given."
  echo "Tip: put LPASS_USERNAME=${user} in ${SERVER_DIR}/.env to skip this prompt."
fi

lock_vault() { lpass logout --force >/dev/null 2>&1 || true; }

# Log out first, because `lpass login` on a live session returns without
# prompting. Starting locked means the master password is required on every run.
lock_vault
trap lock_vault EXIT
trap 'lock_vault; exit 130' INT
trap 'lock_vault; exit 143' TERM

echo "Unlocking LastPass as ${user}. It locks again when this command finishes."
lpass login "$user" >/dev/null || fail "LastPass login failed. Nothing was run."

note=$(lpass show --notes "$NOTE" 2>/dev/null || true)
note_value() { grep -E "^$1=" <<<"$2" | head -1 | cut -d= -f2- || true; }
# A Password entry: the token is its password; the account and zone ids are
# KEY=value lines in its notes.
token=$(lpass show --password "$NOTE" 2>/dev/null || true)
account=$(note_value CLOUDFLARE_ACCOUNT_ID "$note")

# A Cloudflare API call. The token goes in through curl's config on stdin, so it
# never appears in the process list.
cf_api() {
  local tok="$1" method="$2" path="$3" body="${4:-}"
  local args=(-s -X "$method" "https://api.cloudflare.com/client/v4${path}" -K -)
  [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" --data "$body")
  printf 'header = "Authorization: Bearer %s"\n' "$tok" | curl "${args[@]}"
}
json() { python3 -c "import sys,json; d=json.load(sys.stdin); $1"; }

token_works() {
  [[ -n "$token" && -n "$account" ]] || return 1
  cf_api "$token" GET "/accounts/${account}/tokens/verify" | json 'sys.exit(0 if d.get("success") else 1)' 2>/dev/null ||
    cf_api "$token" GET "/user/tokens/verify" | json 'sys.exit(0 if d.get("success") else 1)' 2>/dev/null
}

# Mints this project's own token with the master token from BOOTSTRAP_NOTE, the
# way tribes does, and saves it in NOTE. Runs only when NOTE has no working
# token, because a token's value cannot be read back from Cloudflare: an old
# token of the same name is deleted and replaced.
mint_token() {
  local bootstrap boot zone_name zone_id groups body created
  bootstrap=$(lpass show --notes "$BOOTSTRAP_NOTE" 2>/dev/null) ||
    fail "No working token in '${NOTE}', and the master-token note '${BOOTSTRAP_NOTE}' cannot be read." \
      "Set SPECBOOK_BOOTSTRAP_NOTE to the note that holds your token-minting CLOUDFLARE_API_TOKEN."
  boot=$(note_value CLOUDFLARE_API_TOKEN "$bootstrap")
  [[ -n "$boot" ]] || fail "The note '${BOOTSTRAP_NOTE}' has no CLOUDFLARE_API_TOKEN= line."
  [[ -n "$account" ]] || account=$(note_value CLOUDFLARE_ACCOUNT_ID "$bootstrap")
  [[ -n "$account" ]] || account="${CLOUDFLARE_ACCOUNT_ID:-}"
  [[ -n "$account" ]] || fail "No CLOUDFLARE_ACCOUNT_ID in '${NOTE}', '${BOOTSTRAP_NOTE}' or the environment."

  # The zone is the custom domain's, from wrangler.jsonc, minus any subdomain.
  zone_name=$(grep -oE '"pattern": *"[^"]+"' "$SERVER_DIR/wrangler.jsonc" | head -1 | sed -E 's/.*"([^"]+)"$/\1/' | awk -F. '{print $(NF-1)"."$NF}')
  zone_id=$(note_value CLOUDFLARE_ZONE_ID "$note")
  if [[ -z "$zone_id" ]]; then
    zone_id=$(cf_api "$boot" GET "/zones?name=${zone_name}&account.id=${account}" |
      json 'r=d.get("result") or []; print(r[0]["id"] if r else "")' 2>/dev/null || true)
  fi
  if [[ -z "$zone_id" ]]; then
    echo "The master token cannot look up the zone id for ${zone_name}."
    echo "It is on the zone's Overview page in the Cloudflare dashboard, bottom right."
    read -r -p "Zone id for ${zone_name}: " zone_id </dev/tty
    [[ -n "$zone_id" ]] || fail "No zone id given."
  fi

  echo "Minting the '${TOKEN_NAME}' token with the master token from '${BOOTSTRAP_NOTE}'..."
  groups=$(cf_api "$boot" GET "/user/tokens/permission_groups")
  existing=$(cf_api "$boot" GET "/user/tokens" |
    TOKEN_NAME="$TOKEN_NAME" json 'import os; print(" ".join(t["id"] for t in d.get("result") or [] if t["name"]==os.environ["TOKEN_NAME"]))')
  for id in $existing; do
    cf_api "$boot" DELETE "/user/tokens/${id}" >/dev/null
    echo "  Deleted the old '${TOKEN_NAME}' token (${id}); its value could not be read back."
  done

  body=$(ACCOUNT="$account" ZONE="$zone_id" TOKEN_NAME="$TOKEN_NAME" python3 -c '
import os, sys, json
catalogue = json.load(sys.stdin).get("result") or []
def ids(names):
    found = {g["name"]: g["id"] for g in catalogue}
    missing = [n for n in names if n not in found]
    if missing:
        sys.exit("Cloudflare has no permission group named: " + ", ".join(missing))
    return [{"id": found[n]} for n in names]
print(json.dumps({"name": os.environ["TOKEN_NAME"], "policies": [
    {"effect": "allow",
     "permission_groups": ids(["Workers Scripts Write", "Account Settings Read"]),
     "resources": {"com.cloudflare.api.account." + os.environ["ACCOUNT"]: "*"}},
    {"effect": "allow",
     "permission_groups": ids(["Workers Routes Write", "DNS Write", "Zone Read"]),
     "resources": {"com.cloudflare.api.account.zone." + os.environ["ZONE"]: "*"}},
]}))' <<<"$groups") || fail "Could not build the token request."

  created=$(cf_api "$boot" POST "/user/tokens" "$body")
  token=$(json 'print((d.get("result") or {}).get("value",""))' <<<"$created")
  [[ -n "$token" ]] ||
    fail "Cloudflare refused to mint the token:" "$(json 'print(d.get("errors"))' <<<"$created")"

  # Replaced whole: `lpass edit` changes one field at a time.
  lpass rm "$NOTE" >/dev/null 2>&1 || true
  printf 'URL: https://dash.cloudflare.com/profile/api-tokens\nUsername: %s\nPassword: %s\nNotes:\nCLOUDFLARE_ACCOUNT_ID=%s\nCLOUDFLARE_ZONE_ID=%s\n' \
    "$TOKEN_NAME" "$token" "$account" "$zone_id" | lpass add --non-interactive "$NOTE" >/dev/null
  lpass sync >/dev/null 2>&1 || true
  [[ "$(lpass show --password "$NOTE" 2>/dev/null)" == "$token" ]] ||
    fail "Minted the token but could not save it in '${NOTE}'. Re-run to mint a fresh one."
  echo "  Saved in LastPass as '${NOTE}'. Later runs use it directly."
}

[[ -n "$account" ]] || account="${CLOUDFLARE_ACCOUNT_ID:-}"
token_works || mint_token

# The vault has served its purpose, so lock it before wrangler runs.
lock_vault

account_env=()
[[ -n "$account" ]] && account_env=("CLOUDFLARE_ACCOUNT_ID=$account")

cd "$SERVER_DIR"
[[ $# -gt 0 ]] || set -- deploy
env CLOUDFLARE_API_TOKEN="$token" ${account_env[@]+"${account_env[@]}"} wrangler "$@"
