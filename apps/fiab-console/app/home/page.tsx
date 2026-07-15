import { redirect } from 'next/navigation';

/**
 * /home → / — Home was consolidated onto the root route in the hubs wave
 * (#2085), but /home had been a working URL (nav history, bookmarks, docs
 * links). A dead 404 on a previously-valid URL is a regression; redirect
 * permanently instead.
 */
export default function HomeRedirect() {
  redirect('/');
}
