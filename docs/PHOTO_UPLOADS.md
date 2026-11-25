# Photo self-upload (S-200)

A person can send a photo from a constituency page ("Are you this constituency's member or from their party office? Send a photo").

## What happens
1. The form sends the photo (JPEG or PNG, up to 2 MB) and the details to `POST /api/v1/photos/submissions`. The details go in a header, not the address.
2. The server checks the file by its bytes (not its name or type header), runs the media safety check, removes metadata (JPEG EXIF and comments, PNG text and EXIF chunks) and stores it in `data/photo-submissions/` (set `PHOTO_SUBMISSIONS_DIR` to move it). That folder is not served and not in git.
3. The contact is stored encrypted and is never published.
4. An admin looks at the queue (`GET /api/v1/photos/admin/submissions`, image at `.../:id/file`) and decides (`POST .../:id/decide` with `{"status":"approved"|"rejected","note":"..."}`).
5. Only an approved photo is shown, through the same routes as the other winner photos, so it follows the election-period pause (`PEOPLE_BLACKOUT` / the model code of conduct window) and photo takedowns (target kind `photo`, key `<ST>-assembly-<acNo>`). An approved photo replaces the Wikimedia Commons photo for that seat.

## What it does NOT do
- **No automatic identity check.** The reviewer must compare the claimed name and relationship with the seat's winner, and use the contact to confirm, before approving. Nobody should approve a photo without that.
- Only the **latest assembly winner** of the seat is covered. Other contestants have no page to show a photo on, so the form is not offered for them. Lok Sabha seats are not covered.
- The reviewer screen is the API only; there is no admin page yet. Approving needs an admin sign-in.
- No copyright check beyond the sender's confirmation: the sender states they own the photo or have the right to give it, and permits display with the credit given. A wrong claim is the sender's, but a takedown request removes the photo at once.
- No expiry or re-confirmation of a photo after a new election (a new winner makes the old photo not match; the profile then shows no photo for the new winner).
- Files are not scanned by a real antivirus engine, only the built-in heuristic scanner.
