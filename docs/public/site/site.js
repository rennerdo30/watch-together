// The homepage's room demo: three viewers kept on the room's clock with the
// same rules the room page applies on every heartbeat
// (frontend/app/room/[id]/page.tsx, case 'heartbeat'):
//   drift over 3 s  -> seek to the room's position
//   0.5 to 3 s      -> 1.05x behind, 0.95x ahead
//   within 0.5 s    -> 1x
// Time runs SPEED times faster than real time so a correction is visible.
(function () {
  'use strict';

  var SPEED = 8;
  var HEARTBEAT_S = 5;
  var SEEK_ABOVE_S = 3;
  var NUDGE_ABOVE_S = 0.5;
  var DURATION_S = 42 * 60 + 18;
  var JUMP_SHOWN_S = 16;
  var STALL_S = 2.4;
  var SLEEP_S = 11;
  var SKIP_S = 75;

  var root = document.querySelector('.room-demo');
  if (!root) return;

  var caption = root.querySelector('[data-caption]');
  var roomTime = root.querySelector('[data-room-time]');
  var beat = root.querySelector('[data-beat]');
  var buttons = {};
  root.querySelectorAll('[data-scene]').forEach(function (b) { buttons[b.dataset.scene] = b; });

  var room = { t: 7 * 60 + 41, playing: true };
  var now = 0;
  var nextBeat = HEARTBEAT_S;
  var viewers = {};
  root.querySelectorAll('[data-viewer]').forEach(function (el) {
    viewers[el.dataset.viewer] = {
      el: el,
      t: room.t,
      rate: 1,
      stalledUntil: 0,
      stallKind: '',
      jumpedUntil: 0,
      time: el.querySelector('[data-time]'),
      chip: el.querySelector('[data-chip]'),
      progress: el.querySelector('[data-progress]'),
    };
  });

  function clock(s) {
    s = Math.max(0, Math.floor(s));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function say(text) { caption.textContent = text; }

  function cap(name) { return name.charAt(0).toUpperCase() + name.slice(1); }

  function press(name, on) {
    if (buttons[name]) buttons[name].setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function heartbeat() {
    beat.classList.add('on');
    setTimeout(function () { beat.classList.remove('on'); }, 120);
    Object.keys(viewers).forEach(function (name) {
      var v = viewers[name];
      if (now < v.stalledUntil) return; // a stalled or sleeping tab hears nothing
      var drift = room.t - v.t;
      var before = v.rate;
      if (Math.abs(drift) > SEEK_ABOVE_S) {
        v.t = room.t;
        v.rate = 1;
        v.jumpedUntil = now + JUMP_SHOWN_S;
        say(cap(name) + ' was ' + drift.toFixed(1) + ' s behind, more than three, so their player seeks straight to ' + clock(room.t) + '. One jump, and they are back.');
        press('sleep', false);
      } else if (drift > NUDGE_ABOVE_S) {
        v.rate = 1.05;
        if (before !== v.rate) say(cap(name) + ' is ' + drift.toFixed(1) + ' s behind. Too little to jump: their player runs at 1.05× until the gap is gone, which nobody notices.');
      } else if (drift < -NUDGE_ABOVE_S) {
        v.rate = 0.95;
      } else {
        v.rate = 1;
        if (before !== 1) {
          say(cap(name) + ' is back within half a second of the room, at normal speed again.');
          press('stall', false);
        }
      }
    });
  }

  function render() {
    roomTime.textContent = clock(room.t);
    Object.keys(viewers).forEach(function (name) {
      var v = viewers[name];
      var cls = '';
      var chip = 'in sync';
      if (!room.playing) { cls = 'is-paused'; chip = 'paused'; }
      else if (now < v.stalledUntil) { cls = 'is-off'; chip = v.stallKind; }
      else if (now < v.jumpedUntil) { cls = 'is-jump'; chip = 'jumped'; }
      else if (v.rate > 1) { cls = 'is-off'; chip = 'catching up 1.05×'; }
      else if (v.rate < 1) { cls = 'is-off'; chip = 'easing 0.95×'; }
      v.el.className = 'viewer' + (cls ? ' ' + cls : '');
      v.time.textContent = clock(v.t);
      v.chip.textContent = chip;
      v.progress.style.setProperty('--p', (100 * v.t / DURATION_S).toFixed(2) + '%');
    });
  }

  function step(seconds) {
    now += seconds;
    if (room.playing) {
      room.t = (room.t + seconds) % DURATION_S;
      Object.keys(viewers).forEach(function (name) {
        var v = viewers[name];
        if (now >= v.stalledUntil) v.t = (v.t + seconds * v.rate) % DURATION_S;
      });
      if (now >= nextBeat) {
        nextBeat = now + HEARTBEAT_S;
        heartbeat();
      }
    }
  }

  // Commands go through the server and reach everyone at once.
  function everyoneTo(t) {
    Object.keys(viewers).forEach(function (name) {
      var v = viewers[name];
      v.t = t;
      v.rate = 1;
      v.stalledUntil = 0;
    });
  }

  var scenes = {
    pause: function () {
      room.playing = !room.playing;
      everyoneTo(room.t);
      press('pause', !room.playing);
      press('stall', false);
      press('sleep', false);
      buttons.pause.textContent = room.playing ? 'Alex pauses' : 'Alex plays';
      nextBeat = now + HEARTBEAT_S;
      say(room.playing
        ? 'Play goes to the server, and every player starts from the same frame.'
        : 'Pause goes to the server, which stops the room and tells every player where. Nobody counts down on a call.');
    },
    stall: function () {
      if (!room.playing) scenes.pause();
      var mia = viewers.mia;
      mia.stalledUntil = now + STALL_S;
      mia.stallKind = 'buffering';
      press('stall', true);
      say('Mia’s connection hiccups and their player stops for a moment. The room plays on; the next heartbeat finds them behind.');
    },
    sleep: function () {
      if (!room.playing) scenes.pause();
      var sam = viewers.sam;
      sam.stalledUntil = now + SLEEP_S;
      sam.stallKind = 'tab asleep';
      press('sleep', true);
      say('Sam switches tabs and the browser freezes the room in the background. When it wakes up, Sam is far behind.');
    },
    seek: function () {
      if (!room.playing) scenes.pause();
      room.t = (room.t + SKIP_S) % DURATION_S;
      everyoneTo(room.t);
      Object.keys(viewers).forEach(function (name) { viewers[name].jumpedUntil = now + JUMP_SHOWN_S; });
      press('stall', false);
      press('sleep', false);
      nextBeat = now + HEARTBEAT_S;
      say('Mia drags the seek bar to ' + clock(room.t) + '. A seek is a command, not drift: everyone lands on the same frame together.');
    },
  };

  Object.keys(buttons).forEach(function (name) {
    buttons[name].addEventListener('click', function () { scenes[name](); render(); });
  });

  var visible = true;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; }).observe(root);
  }

  var last = 0;
  function frame(ts) {
    if (last && visible) step(Math.min(0.1, (ts - last) / 1000) * SPEED);
    last = ts;
    render();
    requestAnimationFrame(frame);
  }
  render();
  requestAnimationFrame(frame);
})();
