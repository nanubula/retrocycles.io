#include "doctest.h"
#include "gRouteGuide.h"

#include <cmath>

// Tests for the route guide's geometry (src/tron/gRouteGuide.h): lengths along the
// route, the forward only projection of a cycle onto it, the chevron groups, the
// visible window and the pulse.

namespace
{
// position 2's route of the fortress room: up, double back, down beside the start
// and up again 0.19 units further right
std::vector< eCoord > DoubleBack()
{
    std::vector< eCoord > corners;
    corners.push_back( eCoord( 252.2, 47.8 ) );
    corners.push_back( eCoord( 252.2, 75 ) );
    corners.push_back( eCoord( 254.8, 75 ) );
    corners.push_back( eCoord( 254.8, 52.7 ) );
    corners.push_back( eCoord( 254.99, 52.7 ) );
    corners.push_back( eCoord( 254.99, 234.8 ) );
    return corners;
}

std::vector< eCoord > Straight( REAL length )
{
    std::vector< eCoord > corners;
    corners.push_back( eCoord( 0, 0 ) );
    corners.push_back( eCoord( 0, length ) );
    return corners;
}
}

TEST_SUITE("gRouteGuide")
{
    TEST_CASE("lengths and points along the route")
    {
        gRoutePath path( DoubleBack() );
        CHECK( path.Segments() == 5 );
        CHECK( path.SegmentStart( 1 ) == doctest::Approx( 27.2 ) );
        CHECK( path.Length() == doctest::Approx( 27.2 + 2.6 + 22.3 + .19 + 182.1 ) );

        eCoord const p = path.PointAt( 27.2 + 1.3 );
        CHECK( p.x == doctest::Approx( 253.5 ) );
        CHECK( p.y == doctest::Approx( 75 ) );

        // clamped at both ends
        CHECK( path.PointAt( -5 ).y == doctest::Approx( 47.8 ) );
        CHECK( path.PointAt( 1000 ).y == doctest::Approx( 234.8 ) );
    }

    TEST_CASE("the projection follows the cycle and never goes back")
    {
        gRoutePath path( DoubleBack() );
        REAL off = 0;

        // half way up the first stretch
        REAL progress = path.Advance( 0, eCoord( 252.2, 60 ), eCoord( 0, 1 ), 20, off );
        CHECK( progress == doctest::Approx( 12.2 ) );
        CHECK( off < .001 );

        // a cycle that went back is held where it was
        REAL const held = path.Advance( progress, eCoord( 252.2, 55 ), eCoord( 0, 1 ), 20, off );
        CHECK( held == doctest::Approx( progress ) );
        CHECK( off == doctest::Approx( 5 ) );

        // a stretch that starts beyond the lookahead is not taken, even where it is nearer
        REAL const near = path.Advance( 0, eCoord( 254.8, 60 ), eCoord( 0, 1 ), 5, off );
        CHECK( near == doctest::Approx( 12.2 ) );
        CHECK( off == doctest::Approx( 2.6 ).epsilon( .001 ) );
    }

    TEST_CASE("a stretch that runs against the cycle counts as further away")
    {
        gRoutePath path( DoubleBack() );
        REAL off = 0;

        // on the way down, between the two parallel stretches 0.19 apart
        REAL const down = 27.2 + 2.6 + 19;
        REAL progress = path.Advance( down - 1, eCoord( 254.9, 56 ), eCoord( 0, -1 ), 20, off );
        CHECK( progress == doctest::Approx( down ) );

        // the same point on the way back up is on the last stretch
        REAL const up = 27.2 + 2.6 + 22.3 + .19 + 3.3;
        progress = path.Advance( down + 1, eCoord( 254.9, 56 ), eCoord( 0, 1 ), 20, off );
        CHECK( progress == doctest::Approx( up ) );
        CHECK( off == doctest::Approx( .09 ).epsilon( .01 ) );
    }

    TEST_CASE("chevrons come in packed groups per straight stretch")
    {
        // under 6 units: none
        CHECK( gRoutePath( Straight( 5 ) ).Chevrons().empty() );

        // 6 or more: two, 10 or more: three, 14 or more: four, around the middle
        std::vector< gRoutePath::Chevron > two = gRoutePath( Straight( 8 ) ).Chevrons();
        REQUIRE( two.size() == 2 );
        CHECK( two[0].along == doctest::Approx( 4 - .85 ) );
        CHECK( two[1].along == doctest::Approx( 4 + .85 ) );
        CHECK( two[0].dir.y == doctest::Approx( 1 ) );
        CHECK( gRoutePath( Straight( 12 ) ).Chevrons().size() == 3 );
        CHECK( gRoutePath( Straight( 20 ) ).Chevrons().size() == 4 );

        // 30 or more: a group every 24 units from 12 units in, up to 8 before the end
        std::vector< gRoutePath::Chevron > groups = gRoutePath( Straight( 100 ) ).Chevrons();
        REQUIRE( groups.size() == 4 * 4 );
        CHECK( groups[0].along == doctest::Approx( 12 - 1.5 * 1.7 ) );
        CHECK( groups[4].along == doctest::Approx( 36 - 1.5 * 1.7 ) );
        CHECK( groups[15].along == doctest::Approx( 84 + 1.5 * 1.7 ) );
        CHECK( groups[15].pos.y == doctest::Approx( 84 + 1.5 * 1.7 ) );

        // the route's stretches each get their own (2.6 and 0.19 get none)
        CHECK( gRoutePath( DoubleBack() ).Chevrons().size() == 4 + 4 + 4 * 7 );
    }

    TEST_CASE("the window, the fades and the pulse")
    {
        // at least 45 units, else 3 s at speed
        CHECK( gRouteGuideLook::WindowEnd( 10, 10 ) == doctest::Approx( 55 ) );
        CHECK( gRouteGuideLook::WindowEnd( 10, 40 ) == doctest::Approx( 130 ) );

        // in over 3 units, out over the window's last 18 and the route's last 25
        CHECK( gRouteGuideLook::Fade( 10, 10, 100, 500, true ) == doctest::Approx( 0 ) );
        CHECK( gRouteGuideLook::Fade( 11.5, 10, 100, 500, true ) == doctest::Approx( .5 ) );
        CHECK( gRouteGuideLook::Fade( 11.5, 10, 100, 500, false ) == doctest::Approx( 1 ) );
        CHECK( gRouteGuideLook::Fade( 91, 10, 100, 500, true ) == doctest::Approx( .5 ) );
        CHECK( gRouteGuideLook::Fade( 100, 10, 100, 500, true ) == doctest::Approx( 0 ) );
        CHECK( gRouteGuideLook::Fade( 487.5, 470, 600, 500, true ) == doctest::Approx( .5 ) );

        // the pulse runs at 75 units a second, is gone at 60, and the next leaves 0.5 s later
        CHECK( gRouteGuideLook::PulseFront( .4 ) == doctest::Approx( 30 ) );
        CHECK( gRouteGuideLook::PulseFront( 1.3 + .4 ) == doctest::Approx( 30 ) );
        CHECK( gRouteGuideLook::PulseBump( 30, 30 ) == doctest::Approx( std::pow( .5, 1.2 ) ) );
        CHECK( gRouteGuideLook::PulseBump( 37, 30 ) == doctest::Approx( std::pow( .5, 1.2 ) * std::exp( -1.0 ) ) );
        CHECK( gRouteGuideLook::PulseBump( 38, 30 ) == doctest::Approx( 0 ) );
        CHECK( gRouteGuideLook::PulseBump( 70, gRouteGuideLook::PulseFront( 1.0 ) ) == doctest::Approx( 0 ) );
    }
}
