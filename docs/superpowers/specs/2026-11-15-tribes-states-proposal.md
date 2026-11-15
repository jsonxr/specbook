# Screen states: a proposal

Read-only review of the 44 screens and components (76 states) in `docs/specbook/book.json`, every picture under
`mockups/screens/`, the requirements that point at them, and the app code where a screen's real states were in doubt.
Nothing in any repo was changed.

## 1. The model and the naming rule

**A screen has state variables. Role is one of them.** Each variable has a short name and a small set of values, one
of which is the default (the everyday value). A picture is one combination of values. A variable the picture does not
depend on is "any" and is simply left out.

| Rule | What it means |
|---|---|
| The role is never in the name | The gray pill already says it. "Member · Member" becomes just the Member pill. |
| The name is the non-default values | Home for a member who has not shared is `[Member] Not shared yet`. Home for a visitor, where nothing but the role matters, is `[Visitor]` and no name at all. |
| Only the role differs: one picture per role that looks different, no name | Roles that look identical are `sameAs`; roles that never get there are `absent`. Three role pictures of one screen read `[Visitor]` `[Member]` `[Admin]`. |
| The name is computed, not typed | It is the labels of the non-default values, joined by commas. Nobody can type "Header" again. |
| `when.also` goes away where a variable fits | "has not shared in the directory" becomes `sharing: not shared`. Free words stay only for a one-off note that is not worth a variable. |
| How you got to the screen is not a state | "The server rejected the session" is why Session Expired opens, not a variation of it. That belongs in the screen's intro. |
| Same meaning, same variable name, everywhere | `role`, `app`, `connection`, `data`, `sheet`, `view` mean the same on every screen. |

### Shared variables (declared once for the book)

| Variable | Values (default first) | Used for |
|---|---|---|
| `role` | the book's roles: signed out, no community yet, visitor, member, admin | who is looking; shown as the pill |
| `app` | Tribes app, branded app | the generic app or a community's own app |
| `connection` | online, offline (device has no connection), unreachable (server not answering) | the offline pill, sheet and error wording |
| `data` | some, empty | "No groups yet", "No upcoming events" |
| `sheet` | none, then the sheets that screen can open | a sheet or panel drawn over the screen |
| `view` | the screen's own choices | People: photos or list |
| `sharing` | shared, not shared | a member before and after sharing in the directory |
| `groupAdmin` | no, yes | a member who is "Admin for group" |

Screen-specific variables (for example `invite`, `person`, `listing`) are listed with their screen below.

## 2. Every screen and component

Reading the tables: **Caption** is what the reader would show (pill, then the computed name; "pill only" means no
name). **Was** is today's state id and name. "Not drawn" lists combinations a requirement describes that have no
picture; **bold** ones are recommended, the rest are optional.

### Onboarding

**LandingScreen** — variables: `role` (signed out only), `app`

| Id | Caption | Values | Was |
|---|---|---|---|
| `signedout` | `[Signed out]` pill only | role signed out | `signedout` "Signed out" (name removed) |
| `branded` | `[Signed out]` Branded app | role signed out, app branded | `branded` "Branded" (renamed) |

Signed-in roles never see it (ONB-2ZYR): absent. Nothing undrawn.

**splash screen** — variables: `app`

| Id | Caption | Values | Was |
|---|---|---|---|
| `branded` | `[Anyone]` Branded app | app branded | `branded` "Branded" (renamed) |

Not drawn: the Tribes app's own splash (ONB-GH94), optional.

**SignInScreen** — variables: `role` (signed out), `passkey` (none, offered), `connection`

| Id | Caption | Values | Was |
|---|---|---|---|
| `email` | `[Signed out]` pill only | passkey none | `email` "Email" (name removed) |
| `passkey` | `[Signed out]` Passkey offered | passkey offered | `passkey` "Passkey offered" (kept) |

Not drawn: connection unreachable, the plain "Can't reach the server" wording (ONB-QKQ5), optional.

**VerifyScreen** — variables: `role` (signed out), `code` (entering, wrong), `sheet` (none, save a passkey), `connection`

| Id | Caption | Values | Was |
|---|---|---|---|
| `code` | `[Signed out]` pill only | all default | `code` "Code" (name removed) |
| `savepasskey` | `[Signed out]` Save a passkey | sheet save a passkey | `savepasskey` "Save a passkey" (kept; role was "anyone", make it match its sibling) |

Not drawn: code wrong, "Verification failed" with the boxes cleared (ONB-8KAB), optional.

**NameScreen** — variables: `role` (no community yet). One picture, `account`: caption `[No community yet]` pill only (was "New account", name removed).

**StartCommunityScreen** — variables: `role` (signed out). One picture, `signedout`: pill only (was "Signed out").

**NameYourCommunityScreen** — variables: `role`, `handle` (free, taken)

| Id | Caption | Values | Was |
|---|---|---|---|
| `signedout` | pill only | handle free | `signedout` "Signed out" (name removed). The role looks wrong: by this step the code is accepted, so the person is "No community yet", like NameScreen. |

Not drawn: handle taken, "That handle is taken. Try another one." (ONB-TSXC), optional.

**AcceptInviteScreen** — variables: `role`, `invite` (open, unavailable), `person` (no account, has an account, already signed in, already a member)

| Id | Caption | Values | Was |
|---|---|---|---|
| `newaccount` | `[Signed out]` pill only | role signed out, person no account | `newaccount` "New account" (name removed) |
| `signedin` | `[Anyone]` Already signed in | person already signed in | `signedin` "Already signed in" (kept; role was "member", but the person is not yet a member of the inviting community) |
| `unavailable` | `[Anyone]` Invite unavailable | invite unavailable | `unavailable` "Unavailable" (kept) |

Not drawn: **person has an account, signed out** ("You already have an account. Sign in to join.", ONB-HDUX);
**person already a member** ("You're already a member.", ONB-R7G6). Both are in the app today.

**JoinCommunityScreen** — variables: `role`, `community` (found, not found), `person` (new here, already a member)

| Id | Caption | Values | Was |
|---|---|---|---|
| `signedout` | `[Anyone]` pill only | all default | `signedout` "Signed out" (name removed; the code draws the same confirm screen signed in or out, so role should be "anyone") |

Not drawn: **community not found** (ONB-D3G5); **already a member** (ONB-6T3H); a failed join with Try again (ONB-TKDV), optional.

**NoCommunityScreen** — variables: `role` (no community yet), `app`, `handle` (not entered, not found, found)

| Id | Caption | Values | Was |
|---|---|---|---|
| `account` | `[No community yet]` pill only | all default | `account` "Enter a code" (name removed; it was also wrong, the field takes a handle, not a code) |
| `branded` | `[No community yet]` Branded app | app branded | `branded` "Branded" (renamed) |

Not drawn: **handle found**, the logo with "Is this the right community?" (ONB-B2VK); handle not found (ONB-4ZHN), optional.

**UnreachableScreen** — variables: `connection` (unreachable, offline)

| Id | Caption | Values | Was |
|---|---|---|---|
| `unreachable` | `[Anyone]` Server unreachable | connection unreachable | `unreachable` "Can't reach the server" (renamed; the old name repeated the screen's heading) |

Not drawn: connection offline, the other body text with Try again disabled (ONB-329L, ONB-BXUD), optional.

**LoggedOutScreen** — no variables beyond role "anyone". One picture, `expired`: pill only (was "Session expired", which is the screen itself, not a state of it).

### Communities, header, profile

**HomeScreen** — variables: `role`, `sharing` (member only), `visitors` (admin only: none waiting, waiting), `data`, `connection`, `sheet` (none, offline)

| Id | Caption | Values | Was |
|---|---|---|---|
| `visitor` | `[Visitor]` pill only | role visitor | `visitor` "Visitor" (name removed) |
| `member` | `[Member]` pill only | role member, all default | **`header` "Header"** (see below) |
| `member-notshared` | `[Member]` Not shared yet | sharing not shared | `member` "Member" (renamed: its picture shows the "Share in the directory" card) |
| `admin-waiting` | `[Admin]` Visitors waiting | visitors waiting | `admin` "Admin" (renamed: its picture shows the "Visitors need approval" card) |
| `member-offline` | `[Member]` Offline, sheet open | connection offline, sheet offline | `offline` "Offline" (renamed) |

*What "Header" is.* It is a picture of Home for a member with nothing special going on: the header, three group
rows, the tabs, no card. In the variable model that is exactly the member default, which no other picture covers. So
it is not a duplicate and should not be dropped; it was only named for the section that shows it ("The header and
tabs"). That section keeps showing it, with the header and tab bar highlighted.

*A conflict to settle (question 2).* "Header" and "Offline" draw group rows with no privacy labels and times like
"9:02 AM ›". The Visitor, Member and Admin pictures draw a newer row with Public / Members / Private labels. The
app's HomeScreen code says it renders "the same list for everyone, with no privacy labels". So the two older
pictures match the app and the two newer ones show labels that are not built, yet they carry no "proposed" mark and
are shown by built sections.

*Id swap warning.* `member` changes meaning. The sections that show `HomeScreen.member` today (Groups on Home,
Action cards, Sharing in the directory) all want the share-card picture and must be repointed to `member-notshared`.

Not drawn: **data empty**, "No groups yet" (HOM-G74T); admin with no visitors waiting (the admin's everyday Home);
connection unreachable, where the pill reads "Not connected" (COM-HAZW); the offline sheet's red "sign in again
within 3 days" warning (COM-CJUT is linked to the offline picture, which does not show it).

**CommunitySwitcher** — variables: `role`, `step` (list, join another), `app`

| Id | Caption | Values | Was |
|---|---|---|---|
| `list` | `[Member]` pill only | step list | `list` "Communities" (name removed) |
| `join` | `[Member]` Join another | step join another | `join` "Join another" (kept) |

Not drawn: app branded, no "Start a community" link (WHL-R8FL), optional.

**ProfileScreen** — variables: `role`, `app`

| Id | Caption | Values | Was |
|---|---|---|---|
| `member` | `[Member]` pill only | role member | `member` "Member" (name removed; keeps its proposed change and today's picture) |

Not drawn: **role visitor** (the code gives a visitor no Directory sharing row and "Name, mobile, email" without
photo); app branded, no Communities row (WHL-GKZW), optional. Admin: same as member.

**EditProfileScreen** — variables: `role`. One picture, `member`: pill only (was "Member"). Visitor may differ (no photo); worth checking when it is next touched.

**SignedInDevicesScreen** — variables: `role` (anyone). One picture, `anyone`: pill only (was "Devices").

**ShareInDirectoryScreen** — variables: `role` (member, admin), `sharing`

| Id | Caption | Values | Was |
|---|---|---|---|
| `member` | `[Member]` pill only | sharing not shared (first time) | `member` "Member" (name removed) |

Not drawn: sharing shared, coming back to change or stop sharing (SHR-XCAU), optional. Visitor: absent.

### Groups

**GroupChatScreen** — variables: `role`

| Id | Caption | Values | Was |
|---|---|---|---|
| `visitor` | `[Visitor]` pill only | role visitor | `visitor` "Visitor" (name removed; keeps change and today's picture) |
| `member` | `[Member]` pill only | role member | `member` "Member" (name removed; keeps change and today's picture) |

Admin: same as member. Nothing undrawn ("Could not send" is a system alert).

**GroupDetailScreen** — variables: `role`. One picture, `member`: pill only (was "Member"). Not drawn: **role visitor**, no People row (GRP-HWNZ).

**GroupPeopleScreen** — variables: `role`, `groupAdmin`, `sheet` (none, person panel)

| Id | Caption | Values | Was |
|---|---|---|---|
| `member` | `[Member]` pill only | role member | `member` "Member" (name removed) |
| `admin` | `[Admin]` pill only | role admin | `admin` "Admin" (name removed) |
| `admin-panel` | `[Admin]` Person panel | sheet person panel | `panel` "Person panel" (kept) |

Not drawn, words only: a member with groupAdmin yes looks the same as the admin picture (Add appears for "whoever
manages the group"); record it as `sameAs`.

**AddGroupPeopleScreen** — variables: `role`, `groupAdmin`

| Id | Caption | Values | Was |
|---|---|---|---|
| `admin` | `[Admin]` pill only | role admin | `admin` "Admin" (name removed) |
| `member-groupadmin` | `[Member]` Group admin | groupAdmin yes | `groupadmin` "Group admin" (kept) |

**GroupPhotosScreen**, **GroupPhotoScreen** — variables: `role`. One picture each, `member`: pill only (was "Member").

### Calendar

**CalendarHomeScreen** — variables: `role`, `data`

| Id | Caption | Values | Was |
|---|---|---|---|
| `visitor` | `[Visitor]` pill only | role visitor | `visitor` "Visitor" (name removed) |
| `member` | `[Member]` pill only | role member | `member` "Member" (name removed) |
| `admin` | `[Admin]` same as Member | role admin | `admin` "Admin" (stays `sameAs`) |

Not drawn: **data empty**, "No upcoming events" (CAL-AN3J).

**EventScreen** — variables: `role`, `event` (scheduled, canceled)

| Id | Caption | Values | Was |
|---|---|---|---|
| `event` | `[Anyone]` pill only | event scheduled | `event` "Event" (name removed) |
| `canceled` | `[Anyone]` Canceled | event canceled | `canceled` "Canceled" (kept) |

Both are marked "member" today, but CAL-WBC6 says the page is the same for every role that can open it: role "anyone".

### Directory

**OrganizationList** — variables: `role`, `data`, `mode` (viewing, editing; admin only)

| Id | Caption | Values | Was |
|---|---|---|---|
| `visitor` | `[Visitor]` pill only | role visitor (no Organization / People switch) | `visitor` "Visitor" (name removed) |
| `member` | `[Member]` pill only | role member | `member` "Member" (name removed) |
| `admin` | `[Admin]` pill only | role admin (Edit and "+") | `admin` "Admin" (name removed) |

Not drawn: admin, mode editing (DIR-JBHT); data empty (DIR-RW2N). Both optional.

**ListingScreen** — variables: `role`, `listing` (a person, no person)

| Id | Caption | Values | Was |
|---|---|---|---|
| `person` | `[Member]` pill only | listing a person | `person` "With a person" (name removed) |
| `office` | `[Member]` No person | listing no person | `office` "No person behind it" (kept, shorter) |

Not drawn: **role visitor**, who gets no note and no address (ORG-T8HS). This is a real role difference with no picture.

**EditListingScreen** — variables: `role` (admin), `mode` (new, editing). One picture, `new`: pill only (was "New listing"). Not drawn: editing an existing listing, with Delete (DIR-JBHT), optional.

**CopyFromContactScreen** — variables: `role` (admin). One picture, `admin`: pill only (was "Admin").

**PeopleView** — variables: `role`, `sharing` (member only), `view` (photos, list), `pill` (admin only; the view's default, or All in the photo view), `attention` (admin only: nothing, waiting), `data`

| Id | Caption | Values | Was |
|---|---|---|---|
| `member` | `[Member]` pill only | view photos | `photos` "Photos" (name removed; photos is the default view) |
| `member-list` | `[Member]` List | view list | `list` "List" (kept) |
| `member-notshared` | `[Member]` Not shared yet | sharing not shared | `notshared` "Not shared yet" (kept) |
| `admin` | `[Admin]` pill only | view photos, pill Photo | `adminphotos` "Photos · admin" (name removed) |
| `admin-all` | `[Admin]` All | view photos, pill All | `adminall` "Photos, All · admin" (renamed) |
| `admin-list-attention` | `[Admin]` List, needs attention | view list, attention waiting | `adminlist` "List · admin" (renamed) |
| `visitor` | `[Visitor]` never sees it | absent | `visitor` "Visitor" (stays absent, words unchanged) |

This screen shows the model best: three old names carried "admin" as text because the name was doing the pill's job.
Not drawn: the empty and "No one matches your search" lines, optional.

**ContactScreen** — variables: `role` (who is looking), `person` (a member, not joined, a waiting visitor, yourself, the owner), `invites` (allowed, opted out)

| Id | Caption | Values | Was |
|---|---|---|---|
| `member` | `[Member]` pill only | person a member | `member` "Member viewing a member" (name removed) |
| `admin` | `[Admin]` pill only | person a member | `admin` "Admin viewing a member" (name removed) |
| `admin-notjoined` | `[Admin]` Not joined | person not joined | `notjoined` "Admin viewing someone not joined" (renamed) |

Not drawn: **person a waiting visitor**, where Manage offers Approve (PRS-NL5H); **invites opted out**, "Doesn't want
invites" (PRS-J7JA is linked to the Not joined picture, which shows Resend instead); person yourself or the owner, no
Role switch and no Remove (DIR-AHGP), optional.

**NewPersonScreen** — variables: `role` (admin). One picture, `admin`: pill only (was "Admin").

**NewInviteScreen** — variables: `role` (member), `invites` (none sent, some sent, at the limit). One picture, `member`: pill only (was "Member"). Not drawn: the "Your invites" list under the form (DIR-FZ29), optional.

**NeedsAttentionScreen** — variables: `role` (admin), `data`. One picture, `admin`: pill only (was "Admin"). Not drawn: data empty; the "Recently joined" block (ATN-JAK8) is missing from the one picture. Member and visitor: absent.

### Communications

**lock-screen notification** — variables: `grouping` (single, grouped). One picture, `grouped`: `[Member]` Grouped (kept; "app in the background" is how you get there, not a variable).

**system permission prompt** — variables: `prompt` (notifications). One picture, `notifications`: `[Member]` Notifications (kept).

**NotificationsScreen** — variables: `role`, `system` (allowed, off in Settings)

| Id | Caption | Values | Was |
|---|---|---|---|
| `off` | `[Member]` Off in Settings | system off | `off` "Turned off in Settings" (kept, shorter) |

Not drawn: **system allowed**, the everyday screen. Two requirements (MSG-SEDA, MSG-3QF3) are about the screen as a whole and have only the "off" picture to point at.

**NewAnnouncementScreen** — variables: `role` (admin), `kind` (event canceled, event changed, reminder, news), `reach` (everyone, some will not get it)

| Id | Caption | Values | Was |
|---|---|---|---|
| `admin-canceled` | `[Admin]` Event canceled, some will not get it | kind event canceled, reach some | `admin` "Admin" (renamed: the picture is specifically a cancellation with the "14 people won't get this" warning) |

Not drawn: kind news, the subject-and-body form (MSG-DPLE), optional.

**CommunitySubscriptionsScreen** — variables: `role`. One picture, `member`: pill only (was "Member").

### Components

Components have no role of their own; they take it from the screen that places them.

| Component | Variables | Pictures (was) | Not drawn |
|---|---|---|---|
| NativeTabLayout | `tab` (home, calendar, directory) | Home, Calendar, Directory (all kept) | nothing |
| TabStack | `logo` (has one, none), `photo` (none, has one) | `logo`: no name (was "Logo and profile") | **logo none**, the name in bold (COM-USDM); profile photo (COM-HAV7), optional |
| DirectoryTabs | `tab` (organization, people) | Organization, People (kept) | nothing |
| HeaderGroup | none | `youth`: no name (was "Youth Ministry", which is sample data, not a state) | nothing |

## 3. Structural changes (separate from renames)

1. **Cards and the offline pill are components, not states of Home.** The app already has `ShareCard`, `VisitorsCard`,
   the People attention card, `SharePlaceholder` and `OfflinePill` as their own files, but the pictures draw them
   inline. As components they would own their variables (`connection` belongs to the offline pill, on every tab, not
   to Home), requirements such as HOM-3YDT, HOM-L5XZ, ATN-B3RV, PPL-JHHK and COM-HAZW would attach to them once, and
   Home would keep only `role`, `data` and which cards are placed.
2. **Loading, failed and empty are one shared component.** Every list screen uses the same `QueryState` wrapper for
   these. Draw it once (loading, could not load, empty with its line) instead of once per screen.
3. **Screens the requirements describe that the catalog does not have:** Share join link with the QR code (DIR-PG6P),
   the "Something went wrong" screen (ONB-UYF9), the busy overlay with Cancel (ONB-VAVD), the notification inbox
   (MSG-NMF5), and the email-change code screen (PRO-DW79; `VerifyEmailScreen` exists in the app).
4. **Pictures that have drifted from their requirements** (not a state question, but found on the way): New Person
   has no "Share join link" row (ADD-9X4Q); Invite Someone has no "Choose from contacts" (ADD-NJ3X).
5. **Roles that are wrong today, apart from naming:** NameYourCommunity (signed out, should be "No community yet"),
   AcceptInvite "Already signed in" (member, should be anyone), JoinCommunity (signed out, should be anyone), Event
   (member, should be anyone), VerifyScreen's two states disagree with each other.

## 4. Format change this needs (sketch, for the owner to decide)

Three small additions to the book format; everything else stays.

- **The book declares shared variables once**, beside `roles`. Each has an id, a label, and its values in order; the
  first value is the default. `roles` stays as it is and is the value list of the built-in variable `role`.
  Example in words: `connection` = online (default), offline, unreachable.
- **A screen or component lists the variables it uses**, by id, and may add its own (for example People's `view` =
  photos, list) or narrow a shared one's values. Only listed variables may appear in its states.
- **A state's `when` becomes a set of variable = value pairs** in place of `role` + `also`:
  `when: { role: member, sharing: notshared }`. A variable left out means "any". `also` stays as an optional
  free-text note for the rare one-off, and is shown in the Screens view but not in the caption.
- **`name` becomes optional and normally absent.** The reader builds the caption: the role pill, then the labels of
  the values that are not defaults. A typed `name` overrides it for the few cases that read badly.
- **Validity gains three checks:** every variable and value in a `when` is declared; no two pictures of a screen have
  the same combination; `sameAs` and `absent` work as today.
- **The Screens view can then show coverage**: for each screen, a small grid of role against the other variables,
  with drawn, same-as, absent and "not drawn" cells. Today's "No state for Visitor" hint becomes one case of it.
- **Absent for several roles at once.** Landing is absent for four roles; today that is four states of words. Let
  `when.role` take a list for `absent` and `sameAs` states.

The format reference's own example ("Member: Member", "Admin: Admin", "Visitor: Visitor") teaches the naming this
proposal removes, so it should change with the format.

## 5. Counts

- 76 states today. **0 dropped, 0 merged.** "Header" is kept and becomes the member default of Home.
- **17 keep their name** (they already name a value: Passkey offered, Canceled, Not shared yet, Person panel, ...).
- **59 change**: 45 lose their name entirely (pill only), 14 are renamed to a value (Branded app, Not shared yet,
  Visitors waiting, Not joined, ...).
- **About 35 combinations are implied by requirements but not drawn**; 14 are recommended (bold above), the rest
  optional. Most of the recommended ones already exist in the app.
- 5 states have the wrong role today; 4 state ids on Home and People change meaning and need their `shows` repointed.

## 6. Questions for the owner

1. **Empty caption or a word?** When only the role differs, should the caption be the pill alone (proposed), or the
   pill plus a fixed word such as "Default"?
2. **Home's privacy labels.** The Visitor / Member / Admin pictures of Home show Public / Members / Private labels;
   the app and the older "Header" and "Offline" pictures do not. Are the labels a proposed change (then those
   pictures need marking as proposed, with today's picture beside them), or should they come off?
3. **Does "omitted" mean "any" or "default"?** Proposed: any. The cost is that a picture must list a default value
   when it matters (People for a member lists `view: photos`). The alternative reads shorter but cannot say "any".
4. **Cards and the offline pill as components** (section 3, item 1): do it with this change, or later?
5. **How many of the undrawn combinations do you want drawn?** Proposed: the 14 recommended ones, and the rest only
   listed as "not drawn" in the coverage grid.
6. **State ids.** Rename them to the pattern `<role>` or `<role>-<values>` (proposed, clearer for whoever edits the
   book, but every `shows` and requirement link is rewritten), or leave ids alone and change only what the reader shows?
