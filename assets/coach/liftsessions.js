/* The six strength sessions: four calisthenics (C1-C4) and two for the legs
   (L1, L2), as data. The text is the athlete's own — written for them, kept as
   written — and the shape is what lifts.js and the page read:

   - a section is a titled list of exercises, or `kind: 'circuit'` (a round of
     moves counted with a rounds counter, no sets);
   - an exercise has `sets`, tick boxes per set (two per set when `perSide`),
     and `weighted` when each set takes a weight in kilograms;
   - `guide` is a short list shown under an exercise (the handstand stages).

   Pure data, no code. Whether a session was done, and with which weights, is
   the athlete's log (actuals.js carries it), never anything in this file. */

export const LIFT_SESSIONS = [
  {
    "id": "c1",
    "kind": "calisthenics",
    "code": "C1",
    "name": "Pull strength and handstand",
    "eyebrow": "Week A · Tuesday · C1 calisthenics",
    "minutes": 55,
    "intro": "Pulling strength for swimming and handstand shoulder stability, plus glute and hamstring work. Warm up the wrists first and keep every rep controlled.",
    "plan": "8 warm-up · 12 handstand · 30 pull · 5 glutes and hamstrings",
    "rest": [
      [
        60,
        "60 s"
      ],
      [
        90,
        "90 s"
      ]
    ],
    "notes": [
      "Leave 1 to 2 reps in reserve. Never train a handstand or a heavy lift to failure.",
      "After a hard run, drop one set from the first two main exercises.",
      "Right hamstring: right leg goes first on single-leg work. Nordics stay at your rehab protocol dose, not extra."
    ],
    "sections": [
      {
        "title": "Warm-up",
        "meta": "8 min",
        "items": [
          {
            "id": "wrist",
            "name": "Wrist prep",
            "rx": "2 min",
            "tag": "Wrists",
            "cue": "Palm lifts, fingertip and heel-of-hand rocks, wrist circles. Stop at sharp pain.",
            "sets": 1
          },
          {
            "id": "scap",
            "name": "Scap pull-ups from a hang",
            "rx": "2 × 8",
            "tag": "Back, shoulders",
            "cue": "Arms straight, pull the shoulder blades down and back, then relax. No swinging.",
            "sets": 2
          },
          {
            "id": "er",
            "name": "Band external rotations",
            "rx": "2 × 12",
            "tag": "Shoulders",
            "cue": "Elbow at the ribs, rotate out slowly. Good for swimming shoulders.",
            "sets": 2
          },
          {
            "id": "cb",
            "name": "Clamshells and glute bridges",
            "rx": "2 × 10",
            "tag": "Glutes",
            "cue": "Same pair you use before runs. Hips stacked on clamshells, ribs down on bridges.",
            "sets": 2
          }
        ]
      },
      {
        "title": "Handstand",
        "meta": "10 to 12 min",
        "items": [
          {
            "id": "hs",
            "name": "Handstand drill, your stage",
            "rx": "10 to 12 min",
            "tag": "Skill",
            "cue": "Do the stage you are on. Stop each set when the line breaks, meaning your back arches or your elbows bend. Rest 60 to 90 s between holds.",
            "sets": 5,
            "guide": [
              "1 Chest-to-wall hold: 4 to 5 x 20 to 30 s. Move on at 30 s x 3.",
              "2 Heel pulls off the wall: 5 x 3 pulls of 2 to 3 s. Move on at 3 s, five in a row.",
              "3 Kick up, toes touching the wall: 5 x 10 s. Move on at 10 s x 3 sets.",
              "4 Away from the wall with a bail-out: 8 to 10 attempts. Move on at 3 s x 3.",
              "5 Freestanding holds: 5 to 6 holds. Goal: one clean 10 s hold on 3 different days."
            ],
            "guideTitle": "Stage guide"
          }
        ]
      },
      {
        "title": "Pulling strength",
        "meta": "about 30 min",
        "items": [
          {
            "id": "pu",
            "name": "Pull-up (banded or negatives)",
            "rx": "4 × 4 to 8",
            "tag": "Back, arms",
            "cue": "1 s up, 3 s down, leave 2 reps in reserve. At 8 reps on every set, use a thinner band or add weight.",
            "sets": 4
          },
          {
            "id": "row",
            "name": "Inverted ring or bar row, feet elevated",
            "rx": "3 × 8 to 10",
            "tag": "Back",
            "cue": "Body in a straight plank line. Pause 1 s at the top.",
            "sets": 3
          },
          {
            "id": "hollow",
            "name": "Hollow body hold",
            "rx": "3 × 20 to 30 s",
            "tag": "Core",
            "cue": "Low back flat, steady breathing. Straighten arms and legs to progress.",
            "sets": 3
          },
          {
            "id": "face",
            "name": "Band face pull or prone Y-T",
            "rx": "2 × 15",
            "tag": "Shoulders",
            "cue": "Slow reps. Shoulder balance for swimming and handstands.",
            "sets": 2
          }
        ]
      },
      {
        "title": "Glutes and hamstrings",
        "meta": "about 5 min",
        "items": [
          {
            "id": "sbridge",
            "name": "Single-leg glute bridge",
            "rx": "3 × 8 to 10 / side",
            "tag": "Glutes",
            "cue": "2 s pause at the top. Knee tracks over the second toe. Right side first.",
            "sets": 3,
            "perSide": true
          },
          {
            "id": "nord",
            "name": "Nordic hamstring curl",
            "rx": "Rehab dose",
            "tag": "Hamstrings",
            "cue": "Slow lowering. Follow your 12-week protocol and do not add sets on top.",
            "sets": 1
          }
        ]
      }
    ]
  },
  {
    "id": "c2",
    "kind": "calisthenics",
    "code": "C2",
    "name": "Push, core and handstand",
    "eyebrow": "Week A · Thursday · C2 calisthenics",
    "minutes": 55,
    "intro": "Pressing strength that carries into handstand holds, plus trunk and hip stability. Handstand work comes first while you are fresh.",
    "plan": "8 warm-up · 12 handstand · 25 push · 10 core and calves",
    "rest": [
      [
        30,
        "30 s hold"
      ],
      [
        60,
        "60 s"
      ],
      [
        90,
        "90 s"
      ]
    ],
    "notes": [
      "Leave 1 to 2 reps in reserve. Never train a handstand or a heavy lift to failure.",
      "Handstand push-up negatives (5 s lowering against the wall) only once you hold 30 s chest-to-wall.",
      "Heel: calf raises on a flat floor only, no heel drop off a step. Skip jumps if the heel flares up."
    ],
    "sections": [
      {
        "title": "Warm-up",
        "meta": "8 min",
        "items": [
          {
            "id": "wrist",
            "name": "Wrist prep",
            "rx": "2 min",
            "tag": "Wrists",
            "cue": "Palm lifts, fingertip and heel-of-hand rocks, wrist circles. Stop at sharp pain.",
            "sets": 1
          },
          {
            "id": "scapp",
            "name": "Scap push-ups",
            "rx": "2 × 10",
            "tag": "Shoulders",
            "cue": "Arms straight, let the chest sink between the shoulder blades, then push the floor away.",
            "sets": 2
          },
          {
            "id": "er",
            "name": "Band external rotations",
            "rx": "2 × 12",
            "tag": "Shoulders",
            "cue": "Elbow at the ribs, rotate out slowly. Good for swimming shoulders.",
            "sets": 2
          },
          {
            "id": "clam",
            "name": "Clamshells",
            "rx": "2 × 10 / side",
            "tag": "Glutes",
            "cue": "Mini band above the knees. Hips stacked, pelvis does not roll back.",
            "sets": 2
          }
        ]
      },
      {
        "title": "Handstand",
        "meta": "10 to 12 min",
        "items": [
          {
            "id": "hs",
            "name": "Handstand drill, your stage",
            "rx": "10 to 12 min",
            "tag": "Skill",
            "cue": "Do the stage you are on. Stop each set when the line breaks, meaning your back arches or your elbows bend. Rest 60 to 90 s between holds.",
            "sets": 5,
            "guide": [
              "1 Chest-to-wall hold: 4 to 5 x 20 to 30 s. Move on at 30 s x 3.",
              "2 Heel pulls off the wall: 5 x 3 pulls of 2 to 3 s. Move on at 3 s, five in a row.",
              "3 Kick up, toes touching the wall: 5 x 10 s. Move on at 10 s x 3 sets.",
              "4 Away from the wall with a bail-out: 8 to 10 attempts. Move on at 3 s x 3.",
              "5 Freestanding holds: 5 to 6 holds. Goal: one clean 10 s hold on 3 different days."
            ],
            "guideTitle": "Stage guide"
          }
        ]
      },
      {
        "title": "Pressing strength",
        "meta": "about 25 min",
        "items": [
          {
            "id": "pike",
            "name": "Pike push-up (feet on a box as you get stronger)",
            "rx": "4 × 5 to 8",
            "tag": "Shoulders",
            "cue": "3 s down, leave 2 reps in reserve. Head moves slightly in front of the hands.",
            "sets": 4
          },
          {
            "id": "dip",
            "name": "Parallel-bar or ring dip (banded if needed)",
            "rx": "3 × 6 to 10",
            "tag": "Chest, triceps",
            "cue": "2 s down. Shoulders away from the ears, chest forward.",
            "sets": 3
          },
          {
            "id": "push",
            "name": "Push-up, tempo or deficit",
            "rx": "3 × 8 to 12",
            "tag": "Chest",
            "cue": "3 s down, 1 s pause. Hands on parallettes or feet elevated to progress.",
            "sets": 3
          }
        ]
      },
      {
        "title": "Core and calves",
        "meta": "about 10 min",
        "items": [
          {
            "id": "lsit",
            "name": "Tuck L-sit",
            "rx": "4 × 10 to 15 s",
            "tag": "Core",
            "cue": "Push the floor away. Extend one leg, then both, as it gets easy.",
            "sets": 4
          },
          {
            "id": "splank",
            "name": "Side plank with top-leg lift",
            "rx": "3 × 20 to 30 s / side",
            "tag": "Hip abductors",
            "cue": "Hips stacked. Hip abductor work for knee tracking.",
            "sets": 3,
            "perSide": true
          },
          {
            "id": "calf",
            "name": "Single-leg calf raise, flat floor",
            "rx": "3 × 10 to 12 / side",
            "tag": "Calves",
            "cue": "2 s up, 1 s pause, 2 s down. Flat floor only, no heel drop below the floor.",
            "sets": 3,
            "perSide": true
          }
        ]
      }
    ]
  },
  {
    "id": "c3",
    "kind": "calisthenics",
    "code": "C3",
    "name": "Balance and shoulders",
    "eyebrow": "Week B · Tuesday · C3 calisthenics",
    "minutes": 55,
    "intro": "More time on handstand balance, then upper-body strength with a single-leg hinge for hamstring and hip control.",
    "plan": "8 warm-up · 15 handstand · 30 strength and core",
    "rest": [
      [
        30,
        "30 s hold"
      ],
      [
        60,
        "60 s"
      ],
      [
        90,
        "90 s"
      ]
    ],
    "notes": [
      "Leave 1 to 2 reps in reserve. Never train a handstand or a heavy lift to failure.",
      "After a hard run, drop one set from the first two main exercises.",
      "Right hamstring: right leg goes first on single-leg work. Nordics stay at your rehab protocol dose, not extra."
    ],
    "sections": [
      {
        "title": "Warm-up",
        "meta": "8 min",
        "items": [
          {
            "id": "wrist",
            "name": "Wrist prep",
            "rx": "2 min",
            "tag": "Wrists",
            "cue": "Palm lifts, fingertip and heel-of-hand rocks, wrist circles. Stop at sharp pain.",
            "sets": 1
          },
          {
            "id": "scap",
            "name": "Scap pull-ups from a hang",
            "rx": "2 × 8",
            "tag": "Back, shoulders",
            "cue": "Arms straight, pull the shoulder blades down and back, then relax. No swinging.",
            "sets": 2
          },
          {
            "id": "er",
            "name": "Band external rotations",
            "rx": "2 × 12",
            "tag": "Shoulders",
            "cue": "Elbow at the ribs, rotate out slowly. Good for swimming shoulders.",
            "sets": 2
          },
          {
            "id": "lw",
            "name": "Banded lateral walks",
            "rx": "2 × 12 steps",
            "tag": "Glutes",
            "cue": "Band above the knees, half squat, small steps. Knees track over the second toe.",
            "sets": 2
          }
        ]
      },
      {
        "title": "Handstand",
        "meta": "15 min",
        "items": [
          {
            "id": "hs",
            "name": "Handstand drill, your stage",
            "rx": "15 min",
            "tag": "Skill",
            "cue": "Do the stage you are on. Stop each set when the line breaks, meaning your back arches or your elbows bend. Rest 60 to 90 s between holds. More balance attempts today.",
            "sets": 6,
            "guide": [
              "1 Chest-to-wall hold: 4 to 5 x 20 to 30 s. Move on at 30 s x 3.",
              "2 Heel pulls off the wall: 5 x 3 pulls of 2 to 3 s. Move on at 3 s, five in a row.",
              "3 Kick up, toes touching the wall: 5 x 10 s. Move on at 10 s x 3 sets.",
              "4 Away from the wall with a bail-out: 8 to 10 attempts. Move on at 3 s x 3.",
              "5 Freestanding holds: 5 to 6 holds. Goal: one clean 10 s hold on 3 different days."
            ],
            "guideTitle": "Stage guide"
          },
          {
            "id": "wall",
            "name": "Wall walks (belly to the wall)",
            "rx": "3 × 3 to 5",
            "tag": "Shoulders",
            "cue": "Walk the feet up the wall, hold 5 s at the top, walk back down. Add only if your shoulders recover well.",
            "sets": 3
          }
        ]
      },
      {
        "title": "Strength",
        "meta": "about 30 min",
        "items": [
          {
            "id": "chin",
            "name": "Chin-up",
            "rx": "3 × 5 to 8",
            "tag": "Back, biceps",
            "cue": "Palms facing you, 3 s down. Add reps before weight.",
            "sets": 3
          },
          {
            "id": "ring",
            "name": "Ring push-up or decline push-up",
            "rx": "3 × 8 to 12",
            "tag": "Chest, shoulders",
            "cue": "2 s down. Turn the rings out slightly at the top for shoulder control.",
            "sets": 3
          },
          {
            "id": "knee",
            "name": "Hanging knee raise, then straight-leg raise",
            "rx": "3 × 8 to 10",
            "tag": "Core",
            "cue": "No swinging. Pull the pelvis up, not just the knees.",
            "sets": 3
          },
          {
            "id": "slrdl",
            "name": "Single-leg RDL, bodyweight",
            "rx": "3 × 8 / side",
            "tag": "Hamstrings, glutes",
            "cue": "3 s lowering, reach to the floor, hips level. Right leg first, same reps on both sides.",
            "sets": 3,
            "perSide": true
          },
          {
            "id": "bear",
            "name": "Bear crawl or plank shoulder taps",
            "rx": "3 × 30 s",
            "tag": "Core",
            "cue": "Slow. Hips steady, no rocking.",
            "sets": 3
          }
        ]
      }
    ]
  },
  {
    "id": "c4",
    "kind": "calisthenics",
    "code": "C4",
    "name": "Skill and circuit",
    "eyebrow": "Week B · Thursday · C4 calisthenics",
    "minutes": 45,
    "intro": "The lighter calisthenics day: the most handstand practice of the four sessions, then a moderate circuit at 6 to 7 out of 10 effort.",
    "plan": "6 warm-up · 15 handstand · 20 circuit · 4 hang",
    "rest": [
      [
        30,
        "30 s hold"
      ],
      [
        60,
        "60 s"
      ],
      [
        90,
        "90 s"
      ]
    ],
    "notes": [
      "Keep the circuit smooth and stop short of failure. This day is for skill and easy volume.",
      "Knees track over the second toe. If a knee caves in, stop the set and rest.",
      "Rest 60 to 90 s between rounds. Tick each round with the plus button."
    ],
    "sections": [
      {
        "title": "Warm-up",
        "meta": "6 min",
        "items": [
          {
            "id": "wrist",
            "name": "Wrist prep",
            "rx": "2 min",
            "tag": "Wrists",
            "cue": "Palm lifts, fingertip and heel-of-hand rocks, wrist circles. Stop at sharp pain.",
            "sets": 1
          },
          {
            "id": "scap",
            "name": "Scap pull-ups from a hang",
            "rx": "2 × 8",
            "tag": "Back, shoulders",
            "cue": "Arms straight, pull the shoulder blades down and back, then relax. No swinging.",
            "sets": 2
          },
          {
            "id": "cb",
            "name": "Clamshells and glute bridges",
            "rx": "2 × 10",
            "tag": "Glutes",
            "cue": "Same pair you use before runs. Hips stacked on clamshells, ribs down on bridges.",
            "sets": 2
          }
        ]
      },
      {
        "title": "Handstand",
        "meta": "15 min",
        "items": [
          {
            "id": "hs",
            "name": "Handstand drill, your stage",
            "rx": "15 min",
            "tag": "Skill",
            "cue": "Do the stage you are on. Stop each set when the line breaks, meaning your back arches or your elbows bend. Rest 60 to 90 s between holds. Most practice volume of the four sessions.",
            "sets": 6,
            "guide": [
              "1 Chest-to-wall hold: 4 to 5 x 20 to 30 s. Move on at 30 s x 3.",
              "2 Heel pulls off the wall: 5 x 3 pulls of 2 to 3 s. Move on at 3 s, five in a row.",
              "3 Kick up, toes touching the wall: 5 x 10 s. Move on at 10 s x 3 sets.",
              "4 Away from the wall with a bail-out: 8 to 10 attempts. Move on at 3 s x 3.",
              "5 Freestanding holds: 5 to 6 holds. Goal: one clean 10 s hold on 3 different days."
            ],
            "guideTitle": "Stage guide"
          }
        ]
      },
      {
        "title": "Circuit",
        "meta": "about 20 min",
        "kind": "circuit",
        "id": "circ",
        "note": "One round is all five moves in order. Rest 60 to 90 s between rounds and stop short of failure.",
        "target": "3 to 4 rounds",
        "items": [
          {
            "name": "Push-up",
            "rx": "10 to 12",
            "tag": "Chest",
            "cue": "Smooth reps, full range, body in one line."
          },
          {
            "name": "Inverted row",
            "rx": "10",
            "tag": "Back",
            "cue": "Pause 1 s at the top, plank line from head to heels."
          },
          {
            "name": "Reverse lunge",
            "rx": "8 / side",
            "tag": "Legs",
            "cue": "Lower for 3 s. Front knee tracks over the second toe; stop if it drifts inward."
          },
          {
            "name": "Hollow hold",
            "rx": "30 s",
            "tag": "Core",
            "cue": "Low back flat, breathe steadily."
          },
          {
            "name": "Side plank",
            "rx": "20 s / side",
            "tag": "Hip abductors",
            "cue": "Hips stacked, no sagging."
          }
        ]
      },
      {
        "title": "Finisher",
        "meta": "4 min",
        "items": [
          {
            "id": "hang",
            "name": "Dead hang from a bar",
            "rx": "2 × 30 to 45 s",
            "tag": "Shoulders",
            "cue": "Relaxed shoulders. Decompresses the shoulders after swimming and riding.",
            "sets": 2
          }
        ]
      }
    ]
  },
  {
    "id": "l1",
    "kind": "legs",
    "code": "L1",
    "name": "Heavy legs",
    "eyebrow": "Week A · Wednesday · L1 leg strength",
    "minutes": 55,
    "intro": "The max-strength session: low reps, heavy loads, controlled lowering. Leave 2 reps in reserve on every set and rest fully between the big lifts.",
    "plan": "10 warm-up · 45 lifts and accessories",
    "rest": [
      [
        90,
        "90 s"
      ],
      [
        180,
        "3 min"
      ]
    ],
    "notes": [
      "Type the weight for each set in kg; for dumbbell lifts, enter one dumbbell. Grey numbers are last session's weights, so you can match or beat them.",
      "Keep this session at least 48 hours before Friday's bike intervals and Saturday's long run.",
      "Knees track over the second toe. If a knee caves in, stop the set and rest. Use a band around the knees on squat patterns.",
      "Right hamstring: right leg goes first on single-leg work. Nordics stay at your rehab protocol dose, not extra.",
      "Heel: calf raises on a flat floor only, no heel drop off a step. Skip jumps if the heel flares up."
    ],
    "sections": [
      {
        "title": "Warm-up",
        "meta": "8 to 10 min",
        "items": [
          {
            "id": "gb",
            "name": "Glute bridges",
            "rx": "2 × 10",
            "tag": "Glutes",
            "cue": "Ribs down, squeeze at the top for a second.",
            "sets": 2
          },
          {
            "id": "lw",
            "name": "Banded lateral walks",
            "rx": "2 × 12 steps",
            "tag": "Glutes",
            "cue": "Band above the knees, half squat, small steps. Knees track over the second toe.",
            "sets": 2
          },
          {
            "id": "hh",
            "name": "Bodyweight hip hinge",
            "rx": "2 × 8",
            "tag": "Hips",
            "cue": "Flat back, hips do the work.",
            "sets": 2
          },
          {
            "id": "ramp",
            "name": "Ramp-up sets of the trap-bar deadlift",
            "rx": "2 to 3 sets",
            "tag": "Prep",
            "cue": "Build up to the working weight with 2 or 3 lighter sets of 3 to 5 reps.",
            "sets": 3,
            "perSide": false,
            "weighted": true
          }
        ]
      },
      {
        "title": "Main lifts",
        "meta": "about 30 min",
        "items": [
          {
            "id": "tbdl",
            "name": "Trap-bar deadlift (Romanian deadlift if no trap bar)",
            "rx": "4 × 4 to 5",
            "tag": "Hinge",
            "cue": "2 to 3 s down, smooth drive up, 2 reps in reserve. Add 2.5 to 5 kg when every set is clean.",
            "sets": 4,
            "perSide": false,
            "weighted": true
          },
          {
            "id": "bss",
            "name": "Bulgarian split squat, dumbbells",
            "rx": "3 × 6 to 8 / side",
            "tag": "Single-leg squat",
            "cue": "3 s down. Band around the knees, stop the set when the knee collapses inward. Right leg first.",
            "sets": 3,
            "perSide": true,
            "weighted": true
          },
          {
            "id": "slrdl",
            "name": "Single-leg RDL, dumbbell",
            "rx": "3 × 6 to 8 / side",
            "tag": "Hamstrings, glutes",
            "cue": "3 s down, hips level. Same load both sides, right leg first.",
            "sets": 3,
            "perSide": true,
            "weighted": true
          }
        ]
      },
      {
        "title": "Accessories",
        "meta": "about 12 min",
        "items": [
          {
            "id": "calf",
            "name": "Standing calf raise, weighted, flat floor",
            "rx": "3 × 8 to 10",
            "tag": "Calves",
            "cue": "3 s up, 1 s pause, 2 s down. No heel drop below the floor.",
            "sets": 3,
            "perSide": false,
            "weighted": true
          },
          {
            "id": "abd",
            "name": "Banded lateral walk or side-lying hip abduction",
            "rx": "2 × 12 to 15",
            "tag": "Hip abductors",
            "cue": "Controlled reps. Hip abductor volume for knee tracking.",
            "sets": 2
          },
          {
            "id": "carry",
            "name": "Suitcase carry (optional)",
            "rx": "3 × 30 m / side",
            "tag": "Core",
            "cue": "Tall posture, resist leaning toward the weight.",
            "sets": 3,
            "perSide": true,
            "weighted": true
          }
        ]
      }
    ]
  },
  {
    "id": "l2",
    "kind": "legs",
    "code": "L2",
    "name": "Step-ups and power",
    "eyebrow": "Week B · Wednesday · L2 leg strength and power",
    "minutes": 55,
    "intro": "The unilateral and power session: low-impact jumps first while fresh, then step-ups, hip thrusts and hamstring eccentrics.",
    "plan": "10 warm-up · 8 jumps · 37 strength",
    "rest": [
      [
        90,
        "90 s"
      ],
      [
        180,
        "3 min"
      ]
    ],
    "notes": [
      "Type the weight for each set in kg; for dumbbell lifts, enter one dumbbell. Grey numbers are last session's weights, so you can match or beat them.",
      "Keep this session at least 48 hours before Friday's bike intervals and Saturday's long run.",
      "Skip the jumps if the hamstring or heel complains. Land softly and quietly, and step down rather than jump down.",
      "Right hamstring: right leg goes first on single-leg work. Nordics stay at your rehab protocol dose, not extra.",
      "Heel: calf raises on a flat floor only, no heel drop off a step. Skip jumps if the heel flares up."
    ],
    "sections": [
      {
        "title": "Warm-up",
        "meta": "8 to 10 min",
        "items": [
          {
            "id": "gb",
            "name": "Glute bridges",
            "rx": "2 × 10",
            "tag": "Glutes",
            "cue": "Ribs down, squeeze at the top for a second.",
            "sets": 2
          },
          {
            "id": "lw",
            "name": "Banded lateral walks",
            "rx": "2 × 12 steps",
            "tag": "Glutes",
            "cue": "Band above the knees, half squat, small steps. Knees track over the second toe.",
            "sets": 2
          },
          {
            "id": "su",
            "name": "Bodyweight step-ups",
            "rx": "1 × 8 / side",
            "tag": "Legs",
            "cue": "Controlled, knee tracks over the second toe.",
            "sets": 1,
            "perSide": true
          },
          {
            "id": "pj",
            "name": "Easy practice jumps",
            "rx": "3 to 5",
            "tag": "Prep",
            "cue": "Small, quiet jumps to wake up the legs.",
            "sets": 1
          }
        ]
      },
      {
        "title": "Jumps",
        "meta": "about 8 min",
        "items": [
          {
            "id": "box",
            "name": "Box jump with step-down",
            "rx": "3 × 3",
            "tag": "Power",
            "cue": "Rest a full 90 s between sets and stop if quality drops. Step down rather than jump down.",
            "sets": 3
          },
          {
            "id": "hop",
            "name": "Single-leg hop and stick (low height)",
            "rx": "2 × 3 / side",
            "tag": "Power",
            "cue": "Land softly and hold the landing for 2 s. Right side first.",
            "sets": 2,
            "perSide": true
          }
        ]
      },
      {
        "title": "Strength",
        "meta": "about 37 min",
        "items": [
          {
            "id": "step",
            "name": "High step-up, dumbbells",
            "rx": "4 × 5 / side",
            "tag": "Single-leg squat",
            "cue": "2 s down. Box at knee height, drive through the heel with little push from the back leg.",
            "sets": 4,
            "perSide": true,
            "weighted": true
          },
          {
            "id": "hip",
            "name": "Single-leg hip thrust (or barbell hip thrust)",
            "rx": "3 × 6 to 8 / side",
            "tag": "Glutes",
            "cue": "1 s pause at the top. Ribs down, no arched back. Right side first.",
            "sets": 3,
            "perSide": true,
            "weighted": true
          },
          {
            "id": "nord",
            "name": "Nordic hamstring curl or slider leg curl",
            "rx": "Rehab dose",
            "tag": "Hamstrings",
            "cue": "Slow lowering. Do not add sets on top of the protocol.",
            "sets": 1
          },
          {
            "id": "scalf",
            "name": "Seated calf raise (soleus)",
            "rx": "3 × 10 to 12",
            "tag": "Calves",
            "cue": "3 s up, 1 s pause, 2 s down. Comfortable range only.",
            "sets": 3,
            "perSide": false,
            "weighted": true
          },
          {
            "id": "carry",
            "name": "Suitcase carry (optional)",
            "rx": "3 × 30 m / side",
            "tag": "Core",
            "cue": "Tall posture, resist leaning toward the weight.",
            "sets": 3,
            "perSide": true,
            "weighted": true
          }
        ]
      }
    ]
  }
];
