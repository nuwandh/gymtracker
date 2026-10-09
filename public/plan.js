// The training plan. Edit this file to change exercises, sets, reps or rest times.
// Works in the browser (window.GTPlan) and in Node (require) so tests can use it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GTPlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var SHOULDER = 'Stop if you feel a pinch at the front or top of the shoulder.';
  var BACK = 'Stop if you feel sharp or pinching lower-back pain.';

  // type: 'weight' (kg x reps) or 'time' (seconds).
  // reps: [min, max] target range (seconds for 'time').
  // rest: seconds. jump: smallest weight step in kg when it's time to add weight.
  // early: sets to do in weeks 1-2 (new exercises start with 2 sets).
  function ex(o) {
    o.type = o.type || 'weight';
    return o;
  }

  var A = [
    ex({ id: 'leg-press', name: 'Leg press', sets: 3, reps: [8, 12], rest: 120, jump: 5,
      cue: 'Feet shoulder-width, lower under control, do not lock your knees.' }),
    ex({ id: 'db-bench', name: 'Dumbbell bench press', sub: 'flat, neutral grip', sets: 3, reps: [8, 12], rest: 120, jump: 2,
      cue: 'Shoulder blades back and down, elbows 45-60 degrees, 2 seconds down. Weight is per dumbbell.',
      warn: SHOULDER }),
    ex({ id: 'cable-row', name: 'Seated cable row', sets: 3, reps: [8, 12], rest: 90, jump: 2.5,
      cue: 'Chest up, squeeze your shoulder blades, do not rock your torso.' }),
    ex({ id: 'hip-thrust', name: 'Hip thrust', sets: 3, reps: [8, 12], rest: 90, jump: 5,
      cue: 'Upper back on the bench, ribs tucked, squeeze glutes at the top. Feel it in your glutes, not your lower back.',
      warn: BACK }),
    ex({ id: 'face-pull', name: 'Face pull', sets: 2, reps: [12, 15], rest: 60, jump: 2.5,
      cue: 'Rope at face height, light weight, pull apart toward your face with elbows high.' }),
    ex({ id: 'hammer-curl', name: 'Dumbbell hammer curl', sets: 3, early: 2, reps: [10, 12], rest: 60, jump: 1,
      cue: 'Elbows pinned to your sides, no swinging. Weight is per dumbbell.' }),
    ex({ id: 'pushdown', name: 'Cable triceps pushdown', sets: 3, early: 2, reps: [10, 12], rest: 60, jump: 2.5,
      cue: 'Elbows tucked in, full lockout, control the way up.' }),
    ex({ id: 'calf-raise', name: 'Calf raise', sub: 'your choice of machine', sets: 3, early: 2, reps: [12, 15], rest: 60, jump: 2.5,
      variants: ['Standing calf raise', 'Machine calf raise', 'Leg press calf raise', 'Seated calf raise'],
      cue: 'Full stretch at the bottom (1-2 s), hard squeeze at the top, no bouncing.' }),
    ex({ id: 'plank', name: 'Plank', type: 'time', sets: 3, reps: [30, 45], rest: 60, jump: 0,
      cue: 'Straight line from head to heels, ribs down. Stop the set when your lower back sags.' }),
  ];

  var B = [
    ex({ id: 'goblet-squat', name: 'Goblet squat', sets: 3, reps: [8, 12], rest: 120, jump: 2,
      cue: 'Dumbbell at your chest, sit down between your knees, chest up, neutral back.' }),
    ex({ id: 'lat-pulldown', name: 'Lat pulldown', sets: 3, reps: [8, 12], rest: 90, jump: 2.5,
      cue: 'Pull to your upper chest, elbows down, do not lean back.' }),
    ex({ id: 'db-shoulder-press', name: 'Seated dumbbell shoulder press', sub: 'neutral grip, light', sets: 3, reps: [8, 12], rest: 90, jump: 2,
      cue: 'Palms facing each other, lower to ear level, ribs down. Weight is per dumbbell. Keep it light.',
      warn: SHOULDER }),
    ex({ id: 'db-rdl', name: 'Dumbbell Romanian deadlift', sets: 3, early: 2, reps: [10, 12], rest: 90, jump: 2,
      cue: 'Flat back, push hips back, dumbbells slide down your thighs to mid-shin, 2-3 s down. Light: 3+ reps left in the tank. If your back is tight for more than a day after, swap back to the cable pull-through.',
      warn: BACK }),
    ex({ id: 'lying-leg-curl', name: 'Lying leg curl', sets: 3, early: 2, reps: [10, 12], rest: 90, jump: 2.5,
      cue: 'Hips pressed into the pad, curl up in 1-2 s, lower in about 3 s. If your butt lifts, it is too heavy.' }),
    ex({ id: 'lateral-raise', name: 'Side lateral raise', sets: 3, reps: [12, 15], rest: 60, jump: 1,
      cue: 'Light, lead with your elbows, raise to shoulder height, no swinging.' }),
    ex({ id: 'rear-delt-fly', name: 'Chest-supported rear delt fly', sub: 'light', sets: 3, early: 2, reps: [12, 15], rest: 60, jump: 1,
      cue: 'Face down on a 30-45 degree bench, 2-5 kg per hand, squeeze shoulder blades at the top.',
      warn: SHOULDER }),
    ex({ id: 'db-curl', name: 'Dumbbell curl', sets: 3, early: 2, reps: [10, 12], rest: 60, jump: 1,
      cue: 'No swinging, full range of motion. Weight is per dumbbell.' }),
    ex({ id: 'oh-triceps', name: 'Overhead cable triceps extension', sub: 'light', sets: 3, early: 2, reps: [10, 12], rest: 60, jump: 2.5,
      cue: 'Keep it light. If your shoulder pinches, swap for pushdowns.',
      warn: SHOULDER }),
    ex({ id: 'calf-raise', name: 'Calf raise', sub: 'your choice of machine', sets: 3, early: 2, reps: [12, 15], rest: 60, jump: 2.5,
      variants: ['Standing calf raise', 'Machine calf raise', 'Leg press calf raise', 'Seated calf raise'],
      cue: 'Full stretch at the bottom (1-2 s), hard squeeze at the top, no bouncing.' }),
    ex({ id: 'rkc-plank', name: 'RKC plank', type: 'time', sets: 3, reps: [15, 20], rest: 60, jump: 0,
      cue: 'Squeeze glutes, quads and fists as hard as you can. Short and brutal. Stop if your lower back sags.' }),
  ];

  return {
    warmup: '5-8 min light cardio, arm circles, then 2 light sets of your first lift.',
    workouts: {
      A: { name: 'Day A', exercises: A },
      B: { name: 'Day B', exercises: B },
    },
  };
});
