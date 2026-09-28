import pytest

from garmin_bridge.sports import classify


@pytest.mark.parametrize(
    ("key", "disc"),
    [
        ("lap_swimming", "Swim"),
        ("open_water_swimming", "Swim"),
        ("road_biking", "Bike"),
        ("indoor_cycling", "Bike"),
        ("virtual_ride", "Bike"),
        ("gravel_cycling", "Bike"),
        ("running", "Run"),
        ("treadmill_running", "Run"),
        ("trail_running", "Run"),
        ("strength_training", "Strength"),
        ("multi_sport", "Multisport"),
        ("triathlon", "Multisport"),
        ("transition_v2", "Transition"),
        ("swimtobiketransition", "Transition"),
    ],
)
def test_known_keys(key, disc):
    assert classify(key) == disc


@pytest.mark.parametrize(
    ("key", "disc"),
    [
        ("new_fancy_swimming", "Swim"),
        ("e_bike_something", "Bike"),
        ("mountain_ride", "Bike"),
        ("hill_running", "Run"),
        ("functional_strength", "Strength"),
        ("some_transition_thing", "Transition"),
    ],
)
def test_unknown_keys_fall_back_on_substrings(key, disc):
    assert classify(key) == disc


@pytest.mark.parametrize("key", ["yoga", "pilates", "hiking", "walking", "", None])
def test_anything_else_is_other_never_dropped(key):
    # yootri plans Swim/Bike/Run/Strength; everything else is kept as history
    # but never matched against a planned session.
    assert classify(key) == "Other"


def test_case_and_whitespace_do_not_matter():
    assert classify("  Road_Biking ") == "Bike"
