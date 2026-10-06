// Hand-written string builders that give the same bytes as the nunjucks
// macros in templates/pages.html. Each function takes the same `dot` object
// that the macro gets. Keep them in step with the template: the test
// test/fast_templates.test.js compares both outputs on a seeded database.
import nunjucks from "nunjucks";
import { readFileSync, existsSync } from "node:fs";
import {
  asset,
  avatar as slowAvatar,
  epoch,
  iso,
  versionTime,
  fragment,
} from "./rendering.js";

const { SafeString } = nunjucks.runtime;

// nunjucks lib.escape + runtime.suppressValue with autoescape on.
const ESC = /[&"'<>\\]/;
const ESCG = /[&"'<>\\]/g;
const MAP = {
  "&": "&amp;",
  '"': "&quot;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
  "\\": "&#92;",
};
const rep = (c) => MAP[c];
export function e(v) {
  if (typeof v === "string") return ESC.test(v) ? v.replace(ESCG, rep) : v;
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return "" + v;
  if (v instanceof SafeString) return "" + v.val;
  const s = v.toString();
  return ESC.test(s) ? s.replace(ESCG, rep) : s;
}

// asset() output is fixed once the manifest is loaded (rendering.js caches it).
const assets = new Map();
function A(name) {
  let v = assets.get(name);
  if (v === undefined) assets.set(name, (v = e(asset(name))));
  return v;
}
// avatar() signs the user id with HMAC; the result is the same for the same input.
const avatars = new Map();
function avatar(id, updated) {
  const key = id + "|" + updated;
  let v = avatars.get(key);
  if (v === undefined) {
    if (avatars.size > 20000) avatars.clear();
    avatars.set(key, (v = e(slowAvatar(id, updated))));
  }
  return v;
}
const allEmoji = (s) => !!s && !/[\p{L}\p{N}]/u.test(s);
const len = (x) => x?.length || 0;

// rendering.js reads these generated files on every render; they do not
// change while the process runs, so read them once.
let generatedCache;
function generated() {
  if (!generatedCache) {
    const read = (name) => {
      const path = new URL(`../assets/generated/${name}`, import.meta.url);
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    };
    generatedCache = {
      stylesheets: read("stylesheets.html"),
      importmap: read("importmap.html"),
    };
  }
  return generatedCache;
}

// Sub-macros that are rare or depend only on a small key go through nunjucks.
const call = (name, dot) => fragment(name, dot);
const platformCache = new Map();
function platformBlocks(dot) {
  // These three macros read only dot.Platform and dot.Origin.
  const key = JSON.stringify([dot.Origin, dot.Platform]);
  let v = platformCache.get(key);
  if (v === undefined) {
    const p = { Platform: dot.Platform, Origin: dot.Origin };
    v = [
      call("browser_settings", p),
      call("system_settings", p),
      call("install_instructions", p),
    ];
    if (platformCache.size < 64) platformCache.set(key, v);
  }
  return v;
}

/* ---------------------------------------------------------------- messages */

const REACTIONS = [
  ["👍", "Thumbs up"],
  ["👏", "Clapping"],
  ["👋", "Waving hand"],
  ["💪", "Muscle"],
  ["❤️", "Red heart"],
  ["😂", "Face with tears of joy"],
  ["🎉", "Party popper"],
  ["🔥", "Fire"],
].map(
  ([c, t]) =>
    `/boosts" accept-charset="UTF-8" method="post"><input type="hidden" id="boost_content" name="boost[content]" value="${e(c)}"><button name="button" type="submit" title="${e(t)}" class="btn message__action-btn" data-emoji="${e(c)}"><figure class="margin-none boost-character">${e(c)}</figure><span class="for-screen-reader">${e(t)}</span></button></form>`,
);

export function boost(d) {
  const id = e(d.ID),
    bid = e(d.BoosterID),
    content = e(d.Content);
  return `<div id="boost_${id}" class="boost boost-item flex-inline postion--relative max-width align-center fill-white gap" data-controller="boost-delete" data-boost-delete-perform-class="boost--deleting" data-boost-delete-reveal-class="expanded" data-boost-delete-booster-id-value="${bid}"><figure class="avatar boost__avatar flex-item-no-shrink"><a title="${e(d.BoosterTitle)}" class="btn avatar" data-turbo-frame="_top" href="/users/${bid}"><img aria-label="${e(d.Booster)} boosted ${content}" src="${avatar(d.BoosterID, d.BoosterUpdatedAt)}" width="48" height="48"></a></figure><span role="button" class="txt-small${allEmoji(d.Content) ? " txt-medium" : ""}" data-action="click-&gt;boost-delete#reveal keydown.enter-&gt;boost-delete#reveal:prevent" data-boost-delete-target="content">${content}</span><form class="button_to" method="post" action="/messages/${e(d.MessageID)}/boosts/${id}"><input type="hidden" name="_method" value="delete"><button data-action="boost-delete#perform" data-boost-delete-target="button" class="btn btn--negative flex-item-justify-end boost__delete" type="submit"><img aria-hidden="true" src="${A("minus.svg")}" width="20" height="20"><span class="for-screen-reader">Delete this boost</span></button></form></div><span id="delete_boost_accessible_label" class="for-screen-reader">Press enter to delete this boost</span>`;
}

export function boosts(d) {
  const cid = e(d.ClientID);
  let bs = "";
  const list = d.Boosts;
  if (list) for (let i = 0; i < list.length; i++) bs += boost(list[i]);
  return `<turbo-frame id="boosting_message_${cid}"><div class="boosts flex flex-wrap align-center gap full-width" style="--column-gap: 0.4ch; --row-gap: 0" data-controller="turbo-streaming" data-action="turbo:submit-start->turbo-streaming#unsubscribe"><div class="flex-inline flex-wrap gap" id="boosts_message_${cid}" data-turbo-streaming-target="container">${bs}</div><turbo-frame id="new_boost_message_${cid}"><div class="flex-inline message__boost-inline" data-controller="soft-keyboard"><a class="boost__action txt-small btn" action="soft-keyboard#open" href="/messages/${e(d.ID)}/boosts/new"><img aria-hidden="true" src="${A("boost.svg")}" width="20" height="20"><span class="for-screen-reader">Add a boost</span></a></div></turbo-frame></div></turbo-frame>`;
}

export function presentation(d) {
  return `<div id="presentation_message_${e(d.ClientID)}" dir="auto" data-reply-target="body" data-messages-target="body">
  ${e(d.HTML)}
</div>`;
}

export function messageActions(d) {
  const cid = e(d.ClientID),
    id = e(d.ID);
  const head = `<form data-turbo-frame="boosting_message_${cid}" data-action="popup#close" action="/messages/${id}`;
  let q = "";
  for (let i = 0; i < REACTIONS.length; i++) q += head + REACTIONS[i];
  return `<div class="message__actions" data-controller="soft-keyboard"><details class="position-relative" data-controller="popup" data-action="keydown.esc-&gt;popup#close toggle-&gt;popup#toggle click@document-&gt;popup#closeOnClickOutside" data-popup-orientation-top-class="popup-orientation-top"><summary class="btn message__action-btn message__options-btn"><img class="colorize--black" aria-hidden="true" src="${A("menu-dots-horizontal.svg")}" width="20" height="20"><span class="for-screen-reader">Message options</span></summary><div class="message__actions-menu border shadow" data-popup-target="menu"><div class="quick-boosts">${q}<a class="btn message__action-btn message__boost-btn" data-turbo-frame="new_boost_message_${cid}" data-action="soft-keyboard#open popup#close" href="/messages/${id}/boosts/new"><img class="colorize--black" aria-hidden="true" src="${A("boost.svg")}" width="20" height="20"><span class="for-screen-reader">New boost</span></a></div>
<div class="flex flex-wrap border-top margin-block-start-half pad-block-start-half message__actions-grid">${d.Attachment ? `<a class="btn message__action-btn center full-width hide-in-ios-pwa" title="Download" aria-label="Download" href="${e(d.DownloadURL)}"><img class="colorize--black" aria-hidden="true" src="${A("download.svg")}" width="20" height="20"></a><button class="btn message__action-btn center full-width" data-controller="web-share" data-action="web-share#share" data-web-share-files-value="${e(d.BlobURL)}" data-web-share-title-value="${e(d.Attachment.Filename)}" title="Share" aria-label="Share"><img class="colorize--black" aria-hidden="true" src="${A("share.svg")}" width="20" height="20"></button>` : `<button class="btn message__action-btn center full-width" data-action="reply#reply" title="Reply" aria-label="Reply"><img class="colorize--black" aria-hidden="true" src="${A("reply.svg")}" width="20" height="20"></button>`}<button class="btn message__action-btn center full-width" title="Copy link" aria-label="Copy link" data-controller="copy-to-clipboard" data-action="copy-to-clipboard#copy" data-copy-to-clipboard-success-class="btn--success" data-copy-to-clipboard-content-value="${e(d.Permalink)}"><img class="colorize--black" aria-hidden="true" src="${A("link.svg")}" width="20" height="20"></button><a class="btn message__action-btn center full-width message__edit-btn" data-turbo-frame="edit_message_${cid}" title="Edit" aria-label="Edit" href="/rooms/${e(d.RoomID)}/messages/${id}/edit"><img class="colorize--black" aria-hidden="true" src="${A("pencil.svg")}" width="20" height="20"></a></div></div></details></div>`;
}

export function messageUncached(d) {
  const cid = e(d.ClientID),
    id = e(d.ID),
    creator = e(d.CreatorID),
    title = e(d.CreatorTitle),
    room = e(d.RoomID);
  const created = e(epoch(d.CreatedAt)),
    at = e(iso(d.CreatedAt));
  return `<div id="message_${cid}" class="message ${d.AllEmoji ? "message--emoji" : ""}" data-controller="reply" data-user-id="${creator}" data-message-id="${id}" data-message-timestamp="${created}" data-message-updated-at="${e(epoch(d.UpdatedAt))}" data-sort-value="${created}" data-messages-target="message" data-search-results-target="message" data-refresh-room-target="message" data-reply-composer-outlet="#composer">
<h2 class="message__day-separator"><time datetime="${at}" data-local-time-target="date"></time></h2>
<figure class="avatar message__avatar"><a title="${title}" class="btn avatar" data-turbo-frame="_top" href="/users/${creator}"><img aria-hidden="true" src="${avatar(d.CreatorID, d.CreatorUpdatedAt)}" width="48" height="48"></a></figure>
<turbo-frame id="edit_message_${cid}"><div class="message__body"><div class="message__body-content"><div class="message__meta"><h3 class="message__heading"><span class="message__author" title="${title}"><strong data-reply-target="author">${e(d.Creator)}</strong></span><a target="_top" class="message__permalink" href="/rooms/${room}/@${id}"><time class="message__timestamp" datetime="${at}" data-local-time-target="time"></time></a><span class="message__room"> <a target="_top" data-reply-target="link" href="/rooms/${room}/@${id}">${e(d.RoomName)}</a></span></h3>
${messageActions(d)}</div>
${presentation(d)}
${boosts(d)}
</div></div></turbo-frame></div>`;
}

export function message(d) {
  return d.Fragment ? e(d.Fragment) : messageUncached(d);
}

export function messages(d) {
  if (d.MessagesHTML) return e(d.MessagesHTML);
  let out = "";
  const list = d.Messages;
  if (list) for (let i = 0; i < list.length; i++) out += message(list[i]);
  return out;
}

/* ----------------------------------------------------------------- sidebar */

export function sidebarShared(d) {
  const id = e(d.ID),
    name = e(d.Name);
  return `<a class="align-center gap room btn txt-nowrap${d.Unread ? " unread" : ""}" data-rooms-list-target="room" data-badge-dot-target="unread" data-sorted-list-target="item" data-room-id="${id}" data-sorted-list-name="${name}" id="${e(d.DOM("list"))}" style="--column-gap: 0.5em" href="/rooms/${id}"><span class="overflow-ellipsis">${name}</span></a>`;
}

export function sidebarDirect(d) {
  const id = e(d.ID),
    members = d.Members || [];
  let avatars = "";
  if (len(d.Members) > 1) {
    avatars = `<div class="avatar__group">`;
    for (let i = 0; i < members.length && i < 4; i++)
      avatars += `<span class="avatar"><img src="${avatar(members[i].ID, members[i].UpdatedAt)}" width="20" height="20" aria-hidden="true"></span>`;
    avatars += `</div>`;
  } else
    for (let i = 0; i < members.length; i++)
      avatars += `<span class="avatar"><img src="${avatar(members[i].ID, members[i].UpdatedAt)}" width="48" height="48" aria-hidden="true"></span>`;
  return `<a class="direct${d.Unread ? " unread" : ""}" id="${e(d.DOM("list"))}" data-sorted-list-number="${e(epoch(d.UpdatedAt))}" data-rooms-list-target="room" data-badge-dot-target="unread" data-sorted-list-target="item" data-room-id="${id}" href="/rooms/${id}">${avatars}<span class="direct__author flex align-center gap max-width min-width border-radius txt-small"><span class="txt-nowrap overflow-ellipsis"><span class="for-screen-reader">Ping with</span>${e(d.Label)}</span></span></a>`;
}

export function sidebar(d) {
  const rooms = d.SidebarRooms || [];
  let directs = "",
    shared = "",
    placeholders = "";
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    if (r.Type == "Rooms::Direct") directs += sidebarDirect(r);
    else shared += sidebarShared(r);
  }
  for (const p of d.Placeholders || [])
    placeholders += `<form class="button_to" method="post" action="/rooms/directs?user_ids%5B%5D=${e(p.ID)}"><button class="direct borderless fill-transparent unpad"><span class="avatar"><img src="${avatar(p.ID, p.UpdatedAt)}" aria-hidden="true"></span><span class="direct__author flex align-center gap max-width min-width border-radius txt-small"><span class="txt-nowrap overflow-ellipsis"><span class="for-screen-reader">Start a ping with</span>${e((p.Name || "").split(" ")[0])}</span></span></button></form>`;
  const uid = e(d.User?.ID);
  return `<turbo-frame id="user_sidebar" data-turbo-permanent="true" target="_top" data-controller="rooms-list read-rooms turbo-frame" data-rooms-list-unread-class="unread" data-action="presence:present@window->rooms-list#read read-rooms:read->rooms-list#read turbo:frame-load->rooms-list#loaded refresh-room:visible@window->turbo-frame#reload">
<turbo-cable-stream-source channel="Turbo::StreamsChannel" signed-stream-name="${e(d.RoomsStream)}"></turbo-cable-stream-source><turbo-cable-stream-source channel="Turbo::StreamsChannel" signed-stream-name="${e(d.UserRoomsStream)}"></turbo-cable-stream-source>
<div class="sidebar__container overflow-y overflow-hide-scrollbar" data-controller="badge-dot" data-badge-dot-unread-class="unread" data-action="rooms-list:unread@window->badge-dot#update rooms-list:read@window->badge-dot#update turbo:submit-start->turbo-frame#unpermanize">
<turbo-frame id="direct_rooms_control" target="_top"><div class="directs gap overflow-x overflow-hide-scrollbar"><a class="direct direct__new" data-turbo-frame="_self" href="/rooms/directs/new"><span class="avatar avatar--icon"><img src="${A("messages-add.svg")}" width="20" height="20" aria-hidden="true" class="colorize--black"></span><span class="direct__author flex max-width min-width border-radius pad-inline-half"><span class="for-screen-reader">New</span><span class="txt-small overflow-clip">Ping</span></span></a><div id="direct_rooms" contents data-controller="sorted-list" data-action="rooms-list:unread@window->sorted-list#updateItem">${directs}</div><div contents>${placeholders}</div></div></turbo-frame>
<div class="rooms position-relative flex flex-column gap"><div id="shared_rooms" contents data-controller="sorted-list">${shared}</div>${d.CanCreateRooms ? `<a class="rooms__new-btn btn room align-center gap txt-reversed" aria-label="New Chat Room" href="/rooms/opens/new"><img src="${A("add.svg")}" width="20" height="20" aria-hidden="true" style="view-transition-name: new-room"></a>` : ""}</div>
<button class="btn sidebar__toggle" data-action="toggle-class#toggle"><img src="${A("menu.svg")}" width="20" height="20" aria-hidden="true"><span class="for-screen-reader">Open menu</span></button></div>
<div class="flex align-end sidebar__tools gap justify-end"><a class="btn avatar flex-item-no-shrink sidebar__tool" href="/users/me/profile"><img src="${avatar(d.User?.ID, d.User?.UpdatedAt)}" width="48" height="48" aria-hidden="true" style="view-transition-name: avatar-${uid}"><span class="for-screen-reader">My Settings</span></a><a class="btn align-center gap txt-reversed sidebar__tool" href="/account/edit"><img src="${A("settings.svg")}" width="20" height="20" aria-hidden="true" style="view-transition-name: account-settings"><span class="for-screen-reader">Account Settings</span></a></div></turbo-frame>`;
}

/* -------------------------------------------------------------- room page */

export function composer(d) {
  return `
  <div class="composer flex align-end gap position-relative"
      data-controller="typing-notifications" data-typing-notifications-active-class="typing-indicator--active">
    <a class="btn flex-item-no-shrink margin-block-end composer__context-btn" style="view-transition-name: input-switcher" href="/searches">
      <img aria-hidden="true" src="${A("search.svg")}" width="20" height="20" />
      <span class="for-screen-reader">Search</span>
</a>
    <turbo-frame id="composer-frame">
      <form id="composer" class="margin-block flex-item-grow contain" data-controller="composer drop-target" data-action="dragenter-&gt;drop-target#dragenter dragover-&gt;drop-target#dragover drop-&gt;drop-target#drop drop-target:drop@window-&gt;composer#dropFiles lexxy:file-accept-&gt;composer#preventAttachment refresh-room:online@window-&gt;composer#online typing-notifications#stop paste-&gt;composer#pasteFiles turbo:submit-end-&gt;composer#submitEnd refresh-room:offline@window-&gt;composer#offline" data-composer-messages-outlet="#message-area" data-composer-toolbar-class="composer--rich-text" data-composer-room-id-value="${e(d.Room?.ID)}" action="/rooms/${e(d.Room?.ID)}/messages" accept-charset="UTF-8" method="post">
        <fieldset data-composer-target="fields" contents>
          <div class="flex flex-column">
            <div class="composer__filelist flex flex--align-center gap flex-wrap" data-composer-target="fileList"></div>

            <div class="flex composer__input input input--actor fill-white min-width" style="--input-border-radius: 1.3rem">
              <div class="flex align-end gap full-width">
                <img aria-hidden="true" class="composer__input-hint colorize--black" style="view-transition-name: input-btn;" src="${A("messages-outlined.svg")}" width="22" height="22" />

                <div class="flex flex-column flex-item-grow min-width gap">
                  <lexxy-editor rows="1" class="input lexxy-content" style="order: -1" aria-multiline="true" aria-label="Write a message" permitted-attachment-types="application/vnd.campfire.mention application/vnd.actiontext.opengraph-embed" data-controller="unfurl" data-action="lexxy:change-&gt;typing-notifications#start keydown-&gt;composer#submitByKeyboard:capture lexxy:change-&gt;composer#saveDraft lexxy:insert-link-&gt;unfurl#unfurl" data-composer-target="text" data-direct-upload-url="/rails/active_storage/direct_uploads" data-blob-url-template="/rails/active_storage/blobs/redirect/:signed_id/:filename" id="message_body" input="message_body_trix_input_message" name="message[body]">
                    <lexxy-prompt trigger="@" name="mention" src="/autocompletable/users?room_id=${e(d.Room?.ID)}" remote-filtering="true" empty-results="No matches"></lexxy-prompt>
</lexxy-editor>                </div>

                <label class="btn btn--borderless txt-small flex-item-no-shrink composer__attachment-btn input--file">
                  <img class="colorize--black" aria-hidden="true" src="${A("attachment.svg")}" width="22" height="22" />
                  <input type="file" data-action="composer#filePicked" multiple />
                  <span class="for-screen-reader">Attach a file</span>
                </label>

                <button class="btn btn--borderless txt-small flex-item-no-shrink composer__rich-text-btn" type="button" data-action="composer#toggleToolbar">
                  <img class="colorize--black" aria-hidden="true" src="${A("text-options.svg")}" width="20" height="20" />
                  <span class="for-screen-reader">Rich text</span>
                </button>

                <button name="send" type="submit" data-action="composer#submit" class="btn btn--reversed flex-item-no-shrink txt-small">
                  <img aria-hidden="true" src="${A("arrow-up.svg")}" width="20" height="20" />
                  <span class="for-screen-reader">Send Message</span>
</button>              </div>
            </div>
          </div>
        </fieldset>

        <div class="typing-indicator gap txt-small align-center flex-inline" data-typing-notifications-target="indicator">
          <div class="typing-indicator__author spinner" data-typing-notifications-target="author"></div>
        </div>

        <input data-composer-target="clientid" type="hidden" name="message[client_message_id]" id="message_client_message_id" />
</form>    </turbo-frame>
  </div>
`;
}

export function optimistic(d) {
  return `
<script type="text/template" data-messages-target="template">
  <div class="message message--me $messageClasses$"
      id="message_$clientMessageId$"
      data-format-message-target="message"
      data-user-id="${e(d.User?.ID)}"
      data-message-timestamp="$messageTimestamp$"
      data-messages-target="message">
    <div class="message__day-separator"><time class="message__timestamp" datetime="$messageDatetime$" data-local-time-target="date"></time></div>

    <figure class="avatar message__avatar">
      <a title="${e(d.User?.Title)}" class="btn avatar" data-turbo-frame="_top" href="/users/${e(d.User?.ID)}"><img aria-hidden="true" src="${avatar(d.User?.ID, d.User?.UpdatedAt)}" width="48" height="48" /></a>
    </figure>

    <div class="message__body">
      <div class="message__body-content">
        <div class="message__meta">
          <h3 class="message__heading">
            <span class="message__author"><strong>${e(d.User?.Name)}</strong></span>
            <span class="message__permalink"><time class="message__timestamp" datetime="$messageDatetime$" data-local-time-target="time"></time></span>
          </h3>
          <div class="message__actions">
            <div class="position-relative">
              <span class="btn message__action-btn message__options-btn">
                <img class="colorize--black" aria-hidden="true" src="${A("menu-dots-horizontal.svg")}" />
                <span class="for-screen-reader">Message options</span>
              </span>
            </div class="position-relative">
          </div>
        </div>
        $body$
      </div>
    </div>
  </div>
</script>
`;
}

export function lightbox(d) {
  return `<dialog class="lightbox" aria-label="Image Viewer (Press escape to close)" data-lightbox-target="dialog" data-action="close->lightbox#reset">
  <img src="" class="lightbox__image" data-lightbox-target="zoomedImage" />

  <form method="dialog" class="lightbox__btn">
    <button class="btn">
      <img aria-hidden="true" src="${A("remove.svg")}" />
      <span class="for-screen-reader">Close image viewer</span>
    </button>
  </form>

  <a href="" class="lightbox__btn--download btn hide-in-ios-pwa" data-lightbox-target="download">
    <img aria-hidden="true" src="${A("download.svg")}" />
    <span class="for-screen-reader">Download file</span>
  </a>

  <button class="lightbox__btn--share btn"
      data-controller="web-share"
      data-action="web-share#share"
      data-web-share-files-value=""
      data-lightbox-target="share">
    <img aria-hidden="true" src="${A("share.svg")}" />
    <span class="for-screen-reader">Share file</span>
  </button>
</dialog>

`;
}

export function notificationBell(d) {
  const [browserSettings, systemSettings, installInstructions] =
    platformBlocks(d);
  return `
<span>
  <span class="button_to_change_notifying"
      data-controller="notifications" data-notifications-subscriptions-url-value="/users/me/push_subscriptions" data-notifications-attention-class="btn--pulsing">
    <turbo-frame data-controller="turbo-frame" data-action="notifications:ready@window-&gt;turbo-frame#load" data-turbo-frame-url-param="/rooms/${e(d.Room?.ID)}/involvement" id="${e(d.Room?.DOM("involvement"))}">
      <button class="btn" data-action="click->notifications#attemptToSubscribe" data-notifications-target="bell">
        <img aria-hidden="true" src="${A("notification-bell-loading.svg")}" width="20" height="20" />
        <img aria-hidden="true" hidden="hidden" src="${A("notification-bell-alert.svg")}" width="20" height="20" />
        <span class="for-screen-reader">Notification settings for this ${e(d.Room?.Noun)}</span>
      </button>
</turbo-frame>
    <dialog data-notifications-target="notAllowedNotice" class="dialog pad center center-block border-radius border shadow" style="--inline-space: var(--block-space)">
      <div class="flex flex-column txt-align-center">
        <span class="btn btn--faux center txt-x-large">
          <img aria-hidden="true" src="${A("notification-bell-alert.svg")}" width="48" height="48" />
          <span class="for-screen-reader">Notifications alert</span>
        </span>

        <section>
          <h1 class="txt-large margin-none">Notifications aren’t allowed</h1>
          <div class="txt-align-start margin-block-start">
            ${browserSettings}
            ${systemSettings}
            ${installInstructions}
          </div>
        </section>

        <form method="dialog" class="flex align-center gap center">
          <button class="btn dialog__close" autofocus="true">
            <span class="for-screen-reader">Close</span>
            <img aria-hidden="true" src="${A("remove.svg")}" width="20" height="20" />
          </button>
        </form>
      </div>
    </dialog>
  </span>
</span>
`;
}

function backLink(href) {
  return `<div class="flex-item-justify-start"><a class="btn" href="${href}"><img src="${A("arrow-left.svg")}" aria-hidden="true" width="20" height="20"><span class="for-screen-reader">Go Back</span></a></div>`;
}

function nav(d) {
  const s = d.Screen;
  let out = "";
  if (s == "join")
    out += `<div class="flex-item-justify-end"><a href="/session/new" class="btn flex-item-justify-end"><img src="${A("login-keys.svg")}" aria-hidden="true"><span class="for-screen-reader">Sign in</span></a></div>`;
  if (s == "user") {
    out += `<div class="flex-item-justify-start"><a href="/" class="btn"><img src="${A("arrow-left.svg")}" aria-hidden="true" width="20" height="20"><span class="for-screen-reader">Go Back</span></a></div>`;
    if (d.User?.ID == d.Subject?.ID)
      out += `<div class="flex align-center gap flex-item-justify-end"><a href="/users/me/profile" class="btn"><img src="${A("pencil.svg")}" aria-hidden="true"><span class="for-screen-reader">Edit my profile</span></a></div>`;
  }
  if (s == "bots" || s == "custom-styles" || s == "bot-form")
    out += backLink(s == "bot-form" ? "/account/bots" : "/account/edit");
  if (
    s == "push-subscriptions" ||
    (s == "room-form" && (d.Room?.ID || d.Room?.Type != "Rooms::Direct"))
  )
    out += backLink(e(d.BackPath));
  if (s == "account") out += call("account_nav", d);
  if (s == "profile") out += call("profile_nav", d);
  if (s == "search") out += call("search_nav", d);
  if (d.Chat) {
    if (d.Account?.HasLogo)
      out += `<figure class="account-logo avatar"><img src="/account/logo?v=${e(versionTime(d.Account?.UpdatedAt))}" alt="Account logo" width="300" height="300"></figure>`;
    const roomId = e(d.Room?.ID);
    out += `<span class="btn btn--reversed btn--faux room--current"><h1 class="room__contents txt-medium overflow-ellipsis">${d.Room?.Type == "Rooms::Direct" ? `<span class="for-screen-reader">Ping with </span>` : ""}${e(d.Room?.Name)}</h1></span>
<a class="btn" style="view-transition-name: edit-room-${roomId}" data-room-id="${roomId}" href="${e(d.Room?.EditPath)}"><img aria-hidden="true" src="${A("menu-dots-horizontal.svg")}" width="20" height="20"><span class="for-screen-reader">Settings for this ${e(d.Room?.Noun)}</span></a>
${notificationBell(d)}`;
  }
  return out;
}

export function layoutStart(d) {
  if (d.Frame) return "<html><head></head><body>";
  const g = generated();
  const v = e(versionTime(d.Account?.UpdatedAt));
  let flash = "";
  if (d.Notice || d.Error)
    flash = `<div class="flash" data-controller="element-removal" data-action="animationend->element-removal#remove"><div class="flash__inner shadow"${d.Error ? ` style="--flash-background: var(--color-negative)"` : ""}><img src="${d.Error ? A("alert.svg") : A("check.svg")}" aria-hidden="true" width="24" height="24" class="colorize--white"></div><span class="for-screen-reader" role="alert" aria-atomic="true">${d.Notice ? e(d.Notice) : e(d.Error)}</span></div>`;
  return `<!DOCTYPE html>
<html><head>
<title>${d.Title ? e(d.Title) : "Campfire"}</title>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, interactive-widget=resizes-content">
<meta name="view-transition" content="same-origin"><meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
${d.User?.ID ? `<meta name="current-user-id" content="${e(d.User?.ID)}"><meta name="current-user-name" content="${e(d.User?.Name)}">` : ""}
<meta name="action-cable-url" content="/cable"><meta name="vapid-public-key" content="${e(d.VAPIDPublicKey)}"><meta name="turbo-prefetch" content="true">
<link rel="manifest" href="/webmanifest.json"><link rel="icon" href="/account/logo?v=${v}" type="image/png"><link rel="apple-touch-icon" href="/account/logo?v=${v}">
${g.stylesheets}${e(d.CustomStyles)}${g.importmap}
${d.Reload ? `<meta name="turbo-visit-control" content="reload">` : ""}
${d.Chat ? `<meta name="turbo-cache-control" content="no-preview"><meta name="current-room-id" content="${e(d.Room?.ID)}">` : ""}
</head><body class="${e(d.BodyClass)}${d.User?.Role == 1 ? " admin" : ""}${d.Account?.HasLogo ? " account-has-logo" : ""}" data-controller="local-time lightbox">
<a href="#main-content" class="skip-navigation btn">Skip to main content</a>
<nav id="nav">${nav(d)}</nav>
${flash}
<main id="main-content">`;
}

export function layoutEnd(d) {
  if (d.Frame) return "</body></html>";
  const s = d.Screen;
  let footer = "";
  if (d.Chat) footer = composer(d);
  else if (s == "search") footer = call("search_composer", d);
  else if (s == "account")
    footer = `<div class="txt-align-center center margin-block-double txt-subtle">Campfire&trade; version <span class="version-badge">${e(d.Version)}</span></div>`;
  let aside = "";
  if (s == "search")
    aside = `<div class="rooms position-relative flex flex-column gap overflow-y overflow-hide-scrollbar">${call("recent_searches", d)}</div>`;
  else if (d.Chat || s == "welcome")
    aside = `<turbo-frame id="user_sidebar" src="/users/me/sidebar" data-turbo-permanent="true" target="_top" data-controller="rooms-list read-rooms turbo-frame" data-rooms-list-unread-class="unread" data-action="presence:present@window->rooms-list#read read-rooms:read->rooms-list#read turbo:frame-load->rooms-list#loaded refresh-room:visible@window->turbo-frame#reload"></turbo-frame>`;
  return `<footer id="footer">${footer}</footer></main>
<aside id="sidebar" data-controller="toggle-class" data-toggle-class-toggle-class="open">${aside}</aside>
${lightbox(d)}
<a href="https://once.com" id="app-logo" target="_blank" aria-label="Once software from 37signals home page"><img alt="Campfire logo" src="${A("campfire-icon.png")}" width="256" height="216"></a>
</body></html>`;
}

// Room page. `messagesHTML` (optional) is the already-built messages markup;
// leave it out to build it from dot.MessagesHTML / dot.Messages like the macro.
export function room(d, messagesHTML) {
  const roomId = e(d.Room?.ID);
  return `${layoutStart(d)}
<div id="message-area" class="message-area" contents="true" data-controller="messages presence drop-target" data-action="turbo:before-stream-render@document-&gt;messages#beforeStreamRender keydown.up@document-&gt;messages#editMyLastMessage dragenter-&gt;drop-target#dragenter dragover-&gt;drop-target#dragover drop-&gt;drop-target#drop visibilitychange@document-&gt;presence#visibilityChanged" data-messages-first-of-day-class="message--first-of-day" data-messages-formatted-class="message--formatted" data-messages-me-class="message--me" data-messages-mentioned-class="message--mentioned" data-messages-threaded-class="message--threaded" data-messages-page-url-value="${e(d.Origin)}/rooms/${roomId}/messages">
${optimistic(d)}
<div id="${e(d.Room.DOM("messages"))}" class="messages" data-controller="maintain-scroll refresh-room" data-action="turbo:before-stream-render@document-&gt;maintain-scroll#beforeStreamRender visibilitychange@document-&gt;refresh-room#visibilityChanged online@window-&gt;refresh-room#online" data-messages-target="messages" data-refresh-room-loaded-at-value="${e(d.LoadedAt)}" data-refresh-room-url-value="/rooms/${roomId}/refresh">
${d.Invitation ? call("room_invitation", d) : ""}${messagesHTML ?? messages(d)}</div>
<turbo-cable-stream-source channel="RoomMessagesChannel" signed-stream-name="${e(d.Stream)}"></turbo-cable-stream-source>
<button class="message-area__return-to-latest btn" data-action="messages#returnToLatest" data-messages-target="latest" hidden="hidden"><img aria-hidden="true" src="${A("arrow-down.svg")}" width="20" height="20"><span class="for-screen-reader">Jump to newest message</span></button>
</div>${layoutEnd(d)}`;
}

// Name used by fragment(name) -> fast builder, for the macros covered here.
export const fast = {
  message,
  message_uncached: messageUncached,
  messages,
  presentation,
  message_actions: messageActions,
  boosts,
  boost,
  sidebar,
  sidebar_shared: sidebarShared,
  "sidebar-shared": sidebarShared,
  sidebar_direct: sidebarDirect,
  "sidebar-direct": sidebarDirect,
  room,
  composer,
  optimistic,
  lightbox,
  notification_bell: notificationBell,
  layout_start: layoutStart,
  layout_end: layoutEnd,
};
